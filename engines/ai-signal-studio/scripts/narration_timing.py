"""Build captions and visual cues from measured speech, never text-length timing."""
import json
import math
import re


def plain(text):
    return ''.join(c.lower() for c in text if c.isalnum())


def scene_starts(paragraphs, words, natural=True):
    starts = [0]
    position = 0
    for paragraph in paragraphs[:-1]:
        position += len(plain(paragraph))
        index = next((i for i,w in enumerate(words) if w['charFrom'] == position), None)
        if index is None: raise ValueError('场景边界没有对应词时间戳')
        first = words[index]['startMs']
        # Change picture during the gap; never hide the preceding spoken word.
        lead = min(180, max(0, (first - words[index-1]['endMs']) * .65)) if natural else 0
        starts.append(round((first - lead) * 30 / 1000))
    return starts


def attach_word_timing(spec, words, duration):
    paragraphs = [''.join(s['narration']) for s in spec['scenes']]
    starts = scene_starts(paragraphs, words, spec.get('pacing') == 'conversational')
    total = math.ceil((duration + float(spec.get('tailSeconds', .32))) * 30)
    position = 0
    for i,scene in enumerate(spec['scenes']):
        begin = starts[i]
        end = starts[i+1] if i+1 < len(starts) else total
        char_end = position + len(plain(paragraphs[i]))
        ws = [w for w in words if position <= w['charFrom'] < char_end]
        if not ws: raise ValueError('分镜缺少有效语音时间戳')
        boundaries, cpos = [], position
        for clause in re.split('[，。！？；：、]', paragraphs[i]):
            cpos += len(plain(clause)); boundaries.append(cpos)
        groups = []
        for word in ws:
            if not groups or word['charFrom'] in boundaries or len(''.join(w['text'] for w in groups[-1])) + len(word['text']) > 16:
                groups.append([])
            groups[-1].append(word)
        origin = begin * 1000/30
        scene.update({'from':begin,'durationFrames':end-begin,'audio':'','captions':[]})
        for group in groups:
            scene['captions'].append({'text':''.join(w['text'] for w in group),
                'startMs':round(group[0]['startMs']-origin), 'endMs':round(group[-1]['endMs']-origin),
                'words':[{**w,'startMs':w['startMs']-origin,'endMs':w['endMs']-origin} for w in group],
                'timestampMs':None,'confidence':None})
        scene['speechStartFrame'] = round((ws[0]['startMs']-origin)*30/1000)
        # Explicit phrases are tied to actual word offsets; absent phrases get no fake cue.
        fragment = plain(paragraphs[i])
        cue_frames = []
        for phrase in scene.get('cue_phrases', []):
            offset = fragment.find(plain(phrase))
            if offset < 0:
                cue_frames=[]
                break  # Edited narration invalidates old cues; use ordinary entrances.
            target = position + offset
            word = next(w for w in ws if w['charFrom'] <= target < w['charFrom'] + len(plain(w['text'])))
            cue_frames.append(max(0, round((word['startMs']-origin)*30/1000)-2))
        scene['cueFrames'] = cue_frames
        position = char_end
    spec['durationFrames'] = total
    return spec


def save_timeline(folder, spec):
    captions = [{**c, 'startMs':round(c['startMs']+s['from']*1000/30),
                 'endMs':round(c['endMs']+s['from']*1000/30)} for s in spec['scenes'] for c in s['captions']]
    for filename, value in [('render-props.json',spec),('captions.json',captions)]:
        (folder/filename).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    def clock(ms):
        return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'
    (folder/'captions.srt').write_text('\n\n'.join(f'{i+1}\n{clock(c["startMs"])} --> {clock(c["endMs"])}\n{c["text"]}' for i,c in enumerate(captions))+'\n',encoding='utf-8')
