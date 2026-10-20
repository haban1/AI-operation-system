package robot

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestMarshalTextMoment(t *testing.T) {
	for _, privacy := range []uint32{0, 1} {
		for _, content := range []string{"嗨", "中文 & <标签>\n下一行 😀", "文本 ]]> 仍需保留"} {
			body, err := MarshalTextMoment("wxid_local_test", content, privacy, 1792470000)
			if err != nil {
				t.Fatal(err)
			}
			var parsed TimelineObject
			if err := xml.Unmarshal(body, &parsed); err != nil {
				t.Fatalf("invalid post XML: %v", err)
			}
			if parsed.Username != "wxid_local_test" || parsed.ContentDesc != content || parsed.Private != privacy || parsed.CreateTime != 1792470000 {
				t.Fatalf("text or privacy changed in XML: %#v", parsed)
			}
			if parsed.ContentObject.ContentStyle != 2 || len(parsed.ContentObject.MediaList.Media) != 0 {
				t.Fatal("text post must use style 2 without media")
			}
			for _, tag := range []string{"weappInfo", "streamvideo", "location", "contentattr", "sightFolded", "videoDuration"} {
				if strings.Contains(string(body), "<"+tag) {
					t.Fatalf("text post includes unrelated attachment field %s", tag)
				}
			}
		}
	}
}
