package robot

import "encoding/xml"

// MarshalTextMoment builds a text post without the optional mini-program,
// location and video objects carried by TimelineObject when reading a feed.
// In particular, an empty weappInfo contains empty numeric fields and is not
// a valid mini-program attachment to a text post.
func MarshalTextMoment(username, content string, privacy, createdAt uint32) ([]byte, error) {
	return xml.Marshal(struct {
		XMLName     xml.Name `xml:"TimelineObject"`
		ID          uint64   `xml:"id"`
		Username    string   `xml:"username"`
		CreateTime  uint32   `xml:"createTime"`
		ContentDesc struct {
			Text string `xml:",cdata"`
		} `xml:"contentDesc"`
		ContentDescShowType uint32        `xml:"contentDescShowType"`
		ContentDescScene    uint32        `xml:"contentDescScene"`
		Private             uint32        `xml:"private"`
		ContentObject       ContentObject `xml:"ContentObject"`
	}{
		Username:   username,
		CreateTime: createdAt,
		ContentDesc: struct {
			Text string `xml:",cdata"`
		}{Text: content},
		Private:       privacy,
		ContentObject: ContentObject{ContentStyle: 2},
	})
}
