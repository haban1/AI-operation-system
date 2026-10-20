from __future__ import annotations

import base64
import hashlib
import secrets
import socket
import struct
import time
import xml.etree.ElementTree as ET

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


class WeComCryptoError(ValueError):
    pass


class WeComCrypto:
    def __init__(self, *, token: str, encoding_aes_key: str, corp_id: str) -> None:
        if len(encoding_aes_key) != 43:
            raise WeComCryptoError("WeCom EncodingAESKey must be 43 characters")
        self.token = token
        self.corp_id = corp_id
        self.aes_key = base64.b64decode(f"{encoding_aes_key}=")

    def verify_signature(self, *, signature: str, timestamp: str, nonce: str, encrypted: str) -> None:
        expected = self.signature(timestamp=timestamp, nonce=nonce, encrypted=encrypted)
        if not secrets.compare_digest(expected, signature):
            raise WeComCryptoError("Invalid WeCom message signature")

    def signature(self, *, timestamp: str, nonce: str, encrypted: str) -> str:
        raw = "".join(sorted([self.token, timestamp, nonce, encrypted]))
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def decrypt(self, encrypted: str) -> str:
        try:
            ciphertext = base64.b64decode(encrypted)
            plaintext = _aes_cbc_decrypt(self.aes_key, ciphertext)
            content = _pkcs7_unpad(plaintext)
            msg_len = socket.ntohl(struct.unpack("I", content[16:20])[0])
            msg = content[20 : 20 + msg_len].decode("utf-8")
            receive_id = content[20 + msg_len :].decode("utf-8")
        except Exception as exc:
            raise WeComCryptoError("Failed to decrypt WeCom message") from exc
        if receive_id != self.corp_id:
            raise WeComCryptoError("Invalid WeCom receive id")
        return msg

    def encrypt(self, message_xml: str) -> str:
        random_bytes = secrets.token_bytes(16)
        message_bytes = message_xml.encode("utf-8")
        msg_len = socket.htonl(len(message_bytes))
        packed_len = struct.pack("I", msg_len)
        plaintext = random_bytes + packed_len + message_bytes + self.corp_id.encode("utf-8")
        padded = _pkcs7_pad(plaintext)
        ciphertext = _aes_cbc_encrypt(self.aes_key, padded)
        return base64.b64encode(ciphertext).decode("utf-8")

    def verify_url(self, *, signature: str, timestamp: str, nonce: str, echo: str) -> str:
        self.verify_signature(signature=signature, timestamp=timestamp, nonce=nonce, encrypted=echo)
        return self.decrypt(echo)

    def encrypted_reply(self, *, message_xml: str, nonce: str, timestamp: str | None = None) -> str:
        timestamp = timestamp or str(int(time.time()))
        encrypted = self.encrypt(message_xml)
        signature = self.signature(timestamp=timestamp, nonce=nonce, encrypted=encrypted)
        return _xml(
            {
                "Encrypt": encrypted,
                "MsgSignature": signature,
                "TimeStamp": timestamp,
                "Nonce": nonce,
            }
        )


def parse_xml(xml_text: str) -> dict[str, str]:
    root = ET.fromstring(xml_text)
    return {child.tag: child.text or "" for child in root}


def text_reply_xml(*, to_user: str, from_user: str, content: str) -> str:
    return _xml(
        {
            "ToUserName": to_user,
            "FromUserName": from_user,
            "CreateTime": str(int(time.time())),
            "MsgType": "text",
            "Content": content,
        }
    )


def _xml(values: dict[str, str]) -> str:
    root = ET.Element("xml")
    for key, value in values.items():
        child = ET.SubElement(root, key)
        child.text = value
    return ET.tostring(root, encoding="unicode", short_empty_elements=False)


def _aes_cbc_decrypt(key: bytes, ciphertext: bytes) -> bytes:
    cipher = Cipher(algorithms.AES(key), modes.CBC(key[:16]))
    decryptor = cipher.decryptor()
    return decryptor.update(ciphertext) + decryptor.finalize()


def _aes_cbc_encrypt(key: bytes, plaintext: bytes) -> bytes:
    cipher = Cipher(algorithms.AES(key), modes.CBC(key[:16]))
    encryptor = cipher.encryptor()
    return encryptor.update(plaintext) + encryptor.finalize()


def _pkcs7_pad(value: bytes, block_size: int = 32) -> bytes:
    amount_to_pad = block_size - (len(value) % block_size)
    if amount_to_pad == 0:
        amount_to_pad = block_size
    return value + bytes([amount_to_pad]) * amount_to_pad


def _pkcs7_unpad(value: bytes, block_size: int = 32) -> bytes:
    if not value:
        raise WeComCryptoError("Invalid PKCS7 padding")
    amount_to_pad = value[-1]
    if amount_to_pad < 1 or amount_to_pad > block_size:
        raise WeComCryptoError("Invalid PKCS7 padding")
    return value[:-amount_to_pad]
