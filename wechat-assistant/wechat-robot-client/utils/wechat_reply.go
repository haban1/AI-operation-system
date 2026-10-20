package utils

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	wechatHeading  = regexp.MustCompile(`^([ \t]{0,3})#{1,6}[ \t]+`)
	wechatBullet   = regexp.MustCompile(`^([ \t]*)\*[ \t]+`)
	wechatRule     = regexp.MustCompile(`^[ \t]*\*(?:[ \t]*\*){2,}[ \t]*$`)
	wechatLiteral  = regexp.MustCompile("`+[^`\n]+`+|https?://[^\\s<>]+")
	wechatEmphasis = []*regexp.Regexp{
		regexp.MustCompile(`\*\*\*([^\s*](?:[^*\r\n]*[^\s*])?)\*\*\*`),
		regexp.MustCompile(`\*\*([^\s*](?:[^*\r\n]*[^\s*])?)\*\*`),
		regexp.MustCompile(`\*([^\s*](?:[^*\r\n]*[^\s*])?)\*`),
		regexp.MustCompile(`__([^\s_](?:[^_\r\n]*[^\s_])?)__`),
	}
)

// FormatWechatAIReply removes presentation markup from AI text at the chat
// boundary. Literal stars in redacted data, arithmetic, URLs and code survive.
// User-authored broadcasts and the underlying message transport do not use it.
func FormatWechatAIReply(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	result := make([]string, 0, len(lines))
	var fence string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(trimmed, fence) && strings.Trim(trimmed, fence[:1]) == "" {
				fence = ""
			} else {
				result = append(result, line)
			}
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fence = trimmed[:len(trimmed)-len(strings.TrimLeft(trimmed, trimmed[:1]))]
			continue
		}
		if wechatRule.MatchString(line) {
			result = append(result, "")
			continue
		}
		line = wechatHeading.ReplaceAllString(line, "$1")
		line = wechatBullet.ReplaceAllString(line, "${1}· ")
		result = append(result, formatWechatInline(line))
	}
	return strings.TrimSpace(strings.Join(result, "\n"))
}

func formatWechatInline(line string) string {
	// Protect code and URLs before removing emphasis, including literal * in URLs.
	prefix := "\x00wechat-literal:"
	for strings.Contains(line, prefix) {
		prefix += ":"
	}
	var replacements []string
	offset := 0
	protected := wechatLiteral.ReplaceAllStringFunc(line, func(value string) string {
		start := offset + strings.Index(line[offset:], value)
		offset = start + len(value)
		suffix := ""
		if strings.HasPrefix(value, "`") {
			value = strings.Trim(value, "`")
		} else {
			// A URL may itself be wrapped in emphasis; protect only its address.
			for _, marker := range []string{"***", "**", "*", "__"} {
				if strings.HasSuffix(line[:start], marker) && strings.HasSuffix(value, marker) {
					value, suffix = strings.TrimSuffix(value, marker), marker
					break
				}
			}
		}
		key := fmt.Sprintf("%s%d\x00", prefix, len(replacements)/2)
		replacements = append(replacements, key, value)
		return key + suffix
	})
	// A second pass handles bold text containing italic spans.
	for range 2 {
		for _, pattern := range wechatEmphasis {
			var out strings.Builder
			end := 0
			for _, match := range pattern.FindAllStringSubmatchIndex(protected, -1) {
				start, stop := match[0], match[1]
				out.WriteString(protected[end:start])
				if (start > 0 && wechatLiteralBoundary(protected[start-1])) || (stop < len(protected) && wechatLiteralBoundary(protected[stop])) {
					out.WriteString(protected[start:stop])
				} else {
					out.WriteString(protected[match[2]:match[3]])
				}
				end = stop
			}
			out.WriteString(protected[end:])
			protected = out.String()
		}
	}
	if len(replacements) > 0 {
		protected = strings.NewReplacer(replacements...).Replace(protected)
	}
	return protected
}

func wechatLiteralBoundary(ch byte) bool {
	return ch == '*' || ch == '_' || ch == '\\' || ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z'
}
