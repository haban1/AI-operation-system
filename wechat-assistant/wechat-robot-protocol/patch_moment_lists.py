"""Prepare a version-locked fix for empty recipient lists in iPad 8074 v1.2.2.

This script never modifies a running container or sends a WeChat request.
It refuses an unfamiliar executable and writes a separate patched file.
"""

import argparse
import hashlib
import json
from pathlib import Path
import struct


ORIGINAL_SHA256 = "39de506fd266bf126f62c11f7bfcb0c17a4aaedb0565e808a35cd7708ae4dc95"
SITES = (0xBCCD7F, 0xBCCF36, 0xBCCFA7)
# Go ABIInternal strings.genSplit(s, sep, sepSave, n): len(s) is BX, n is R8.
# Before: MOVQ $-1, R8. After: MOVQ BX, R8; NEGQ R8; NOP.
# n == 0 yields nil; n < 0 retains the original unlimited split behavior.
BEFORE = bytes.fromhex("49 c7 c0 ff ff ff ff")
AFTER = bytes.fromhex("49 89 d8 49 f7 d8 90")


def file_offset(binary, address):
    if binary[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Expected a little-endian ELF64 executable")
    phoff = struct.unpack_from("<Q", binary, 32)[0]
    phsize, phcount = struct.unpack_from("<HH", binary, 54)
    for i in range(phcount):
        ptype, flags, offset, vaddr, _, filesz, _, _ = struct.unpack_from(
            "<IIQQQQQQ", binary, phoff + i * phsize
        )
        if ptype == 1 and flags & 1 and vaddr <= address and address + 7 <= vaddr + filesz:
            return offset + address - vaddr
    raise ValueError(f"Patch address {address:#x} is outside executable file data")


def write_tests(folder, before, patched_regions):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "go.mod").write_text("module moment-list-patch-check\n\ngo 1.25\n", encoding="utf-8")
    declarations = []
    asm = ['#include "textflag.h"', ""]
    for name, code in [("originalLimit", before)] + [
        (f"patchedLimit{i}", region) for i, region in enumerate(patched_regions)
    ]:
        declarations.append(f"func {name}(length int) int")
        asm.extend([
            f"TEXT ·{name}(SB), NOSPLIT, $0-16",
            "    MOVQ length+0(FP), BX",
            *[f"    BYTE $0x{byte:02x}" for byte in code],
            "    MOVQ R8, ret+8(FP)",
            "    RET",
            "",
        ])
    (folder / "limit_amd64.s").write_text("\n".join(asm), encoding="utf-8")
    (folder / "limit_test.go").write_text('''package patchcheck

import (
    "reflect"
    "strings"
    "testing"
)

''' + "\n".join(declarations) + '''

func TestEmptyListBeforeAndAfter(t *testing.T) {
    original := strings.SplitN("", ",", originalLimit(0))
    if !reflect.DeepEqual(original, []string{""}) {
        t.Fatalf("old instructions did not reproduce the empty username: %#v", original)
    }
    for i, limit := range []func(int) int{patchedLimit0, patchedLimit1, patchedLimit2} {
        actual := strings.SplitN("", ",", limit(0))
        if actual != nil {
            t.Errorf("site %d: empty list must contain zero usernames: %#v", i, actual)
        }
    }
}

func TestNonemptyListsPreserved(t *testing.T) {
    for i, limit := range []func(int) int{patchedLimit0, patchedLimit1, patchedLimit2} {
        for _, input := range []string{"wxid_one", "wxid_one,wxid_two", "甲,乙", "a,,b", ",", " "} {
            actual := strings.SplitN(input, ",", limit(len(input)))
            expected := strings.SplitN(input, ",", originalLimit(len(input)))
            if !reflect.DeepEqual(actual, expected) {
                t.Errorf("site %d: list changed: %#v -> %#v", i, expected, actual)
            }
        }
        for _, length := range []int{0, 1, 2, 1024, int(^uint(0) >> 1)} {
            if actual := limit(length); actual != -length {
                t.Errorf("site %d: limit(%d) = %d", i, length, actual)
            }
        }
    }
}
''', encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--test-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        raise ValueError("Input must be preserved; choose a separate output path")
    original = args.input.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest != ORIGINAL_SHA256:
        raise ValueError(f"Unsupported executable SHA-256 {digest}; no output written")
    patched = bytearray(original)
    changes = []
    for address in SITES:
        offset = file_offset(original, address)
        if original[offset:offset + 7] != BEFORE:
            raise ValueError(f"Unexpected instructions at {address:#x}")
        patched[offset:offset + 7] = AFTER
        changes.append({"address": hex(address), "file_offset": offset,
                        "before": BEFORE.hex(" "), "after": AFTER.hex(" ")})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(patched)
    args.output.chmod(0o755)
    manifest = {"original_sha256": digest, "patched_sha256": hashlib.sha256(patched).hexdigest(),
                "changed_bytes": sum(a != b for a, b in zip(original, patched)), "sites": changes}
    args.output.with_suffix(args.output.suffix + ".json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    write_tests(args.test_dir, BEFORE, [patched[item["file_offset"]:item["file_offset"] + 7] for item in changes])
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
