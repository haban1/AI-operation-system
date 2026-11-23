// The base editor owns media, branding, audio, and the single composition clock.
const cardKeys = ['title', 'beat1', 'beat2', 'beat3', 'beat4', 'beat5'];
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
const glyphs = text => segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text);

export function steadyCard(card, index, fields, z, escape, portrait) {
  const style = cardKeys.indexOf(card.key);
  if (style < 0) return '';
  const value = String(fields[card.key] ?? '').trim();
  if (!value) return '';
  // Honor a deliberate line break. Without one, two-part styles divide copy at
  // a space/punctuation near the midpoint, or at the nearest complete glyph.
  let lines = value.split(/\r?\n/).map(glyphs);
  if (lines.length === 1 && [1, 3, 4, 5].includes(style) && lines[0].length > 2) {
    const text = lines[0], middle = Math.ceil(text.length / 2);
    const breaks = text.flatMap((ch, i) => /[\s，、：；。！？,;:!?]/u.test(ch) && i > 0 && i + 1 < text.length ? [i + 1] : []);
    const cut = breaks.sort((a, b) => Math.abs(a-middle)-Math.abs(b-middle))[0] ?? middle;
    lines = [text.slice(0, cut), text.slice(cut)];
  }
  const leading = style === 0 || style === 2 ? 7 : 8;
  const chars = lines.map((line, n) => {
    const row = line.map(ch => {
      const text = escape(ch);
      return '<span class="st-cell"><span class="st-ink" data-glyph="' + text + '">' + text + '</span></span>';
    }).join('');
    return '<span class="st-row st-row-' + n + '">' + row + '</span>';
  }).join('');
  // Keep long, valid edits within the safe area at the fixed composition resolution.
  const longest = Math.max(1, ...lines.map(l => l.length));
  const sizes = portrait ? [130, 117, 112, 117, 120, 129] : [115, 99, 98, 99, 110, 112];
  const shrink = Math.min(1, (portrait ? leading : leading + 3) / longest);
  const size = Math.max(portrait ? 48 : 42, Math.floor(sizes[style] * shrink));
  const note = style === 0 && fields.subtitle ? '<span class="st-note">' + escape(fields.subtitle) + '</span>' : '';
  return '<div id="title-' + index + '" class="title-card st-card st-c' + style + '" style="z-index:' + z +
    ';--st-size:' + size + 'px"><div class="st-block"><h1 aria-label="' + escape(value) + '">' + chars +
    '</h1><i class="st-rule" aria-hidden="true"></i>' + note + '</div></div>';
}

export const steadyCss = `
.steady-type .view{inset:0;width:100%;height:100%;transform:none}
.steady-type .vignette,.steady-type .end-line{display:none}
.steady-type .scene{perspective:none}
.steady-type .primary{--st-edge:115%;--st-feather:12%;--st-angle:108deg}
.steady-type .st-swept{mask-image:linear-gradient(var(--st-angle),black var(--st-edge),transparent calc(var(--st-edge) + var(--st-feather)))}
.steady-type .st-bloom-cut{mask-image:radial-gradient(ellipse farthest-corner at 70% 32%,black var(--st-edge),transparent calc(var(--st-edge) + var(--st-feather)))}
.steady-type .st-optic{position:absolute;inset:0;pointer-events:none;opacity:0;--st-light:28%;background:linear-gradient(115deg,rgba(255,195,128,.42),rgba(255,230,179,.05));backdrop-filter:blur(4px) brightness(1.045);mask-image:radial-gradient(ellipse 26% 41% at var(--st-light) 49%,black 0%,rgba(0,0,0,.50) 40%,transparent 100%)}
.steady-type .st-bloom{background:rgba(255,230,194,.13);backdrop-filter:blur(3px) brightness(1.09);mask-image:radial-gradient(ellipse 42% 36% at 72% 25%,black,transparent 100%)}
.steady-type .st-card{position:absolute;inset:0;display:block;visibility:visible;opacity:0;padding:0;overflow:hidden;text-align:left;perspective:1300px;--st-primary:#fffdf4;--st-color:var(--accent);color:var(--st-primary)}
.steady-type .st-block{position:absolute;left:7%;width:82%;bottom:17%;text-shadow:1px 3px 4px #18222abf,0 1px 12px #10181db3}
.steady-type .st-c0 .st-block,.steady-type .st-c3 .st-block{top:17%;bottom:auto}
.steady-type.portrait .st-c0 .st-block,.steady-type.portrait .st-c3 .st-block{top:18%}
.steady-type .st-block h1{font:800 var(--st-size)/1.12 "Microsoft YaHei","PingFang SC","Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif;margin:0;letter-spacing:0;white-space:normal;overflow-wrap:anywhere}
.steady-type .st-row{display:block;padding:.03em 0}
.steady-type .st-cell,.steady-type .st-ink{display:inline-block;position:relative;white-space:pre;vertical-align:top}
.steady-type .st-ink{paint-order:stroke fill;-webkit-text-stroke:1.7px #14202bba;transform-origin:50% 75%}
.steady-type .st-note{display:block;font-size:29px;line-height:1.35;font-weight:600;color:#fffdf4;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:14px;max-width:90%}
.steady-type .st-rule{display:block;width:114px;height:5px;margin:15px 0 0;background:var(--st-color);transform-origin:left;box-shadow:0 1px 3px #18212b7a}
.steady-type .st-c0 .st-ink{color:transparent;-webkit-text-stroke:2px #fffdf4;--st-fill:-36%}
.steady-type .st-c0 .st-ink::after{content:attr(data-glyph);position:absolute;inset:0;clip-path:polygon(-40% 0,calc(var(--st-fill) + 30%) 0,var(--st-fill) 100%,-40% 100%);color:var(--st-primary);-webkit-text-stroke:1px #2330399c;text-shadow:none}
.steady-type .st-c0 .st-cell:nth-child(n+3){--st-primary:var(--st-color)}
.steady-type .st-c1{--st-color:#ffcf70}
.steady-type .st-c1 .st-cell{overflow:hidden;vertical-align:bottom}
.steady-type .st-c1 .st-row-0:not(:last-child),.steady-type .st-c3 .st-row-0:not(:last-child),.steady-type .st-c5 .st-row-0:not(:last-child){font-size:.62em}
.steady-type .st-c1 .st-row:last-child,.steady-type .st-c5 .st-row:first-child{font-family:"Songti SC",SimSun,"Noto Serif CJK SC",serif}
.steady-type .st-c1 .st-row:last-child{color:var(--st-color)}
.steady-type .st-c1 .st-rule,.steady-type .st-c2 .st-rule{width:2.3em;font-size:var(--st-size);height:4px;transform:rotate(-2deg)}
.steady-type .st-c2{--st-color:#ffb39a}
.steady-type .st-c2 h1{font-family:KaiTi,STKaiti,"AR PL UKai CN","Kaiti SC","Noto Serif CJK SC",serif;font-weight:600}
.steady-type .st-c2 .st-row .st-cell:nth-child(n+4){color:var(--st-color)}
.steady-type .st-c3{--st-color:#a4f1ff}
.steady-type .st-c3 .st-row:last-child,.steady-type .st-c4 .st-row:last-child,.steady-type .st-c5 .st-row:last-child{color:var(--st-color)}
.steady-type .st-c3 .st-rule{width:.43em;height:.11em;font-size:var(--st-size)}
.steady-type .st-c4{--st-color:#ffb9d9}
.steady-type .st-c4 .st-row:last-child:not(:first-child){margin-left:8%}
.steady-type .st-c4 .st-rule{width:53px;height:14px;background:none;border-left:4px solid var(--st-color);border-bottom:4px solid var(--st-color)}
.steady-type .st-c5{--st-color:#ffce79}
.steady-type .st-c5 .st-row{perspective:700px}
.steady-type .st-c5 .st-ink{backface-visibility:visible;transform-origin:center center}
`;

// Serialized into the generated composition. Keep all dependencies local to the timeline.
export function addSteadyTimeline(tl, config) {
  const strength = Math.min(1, Math.max(0, Number(config.settings.intensity)));
  const from = (target, start, end, at) => tl.fromTo(target, start, { ...end, immediateRender: false }, at);
  const feather = (plane, at, length, angle, spread) => {
    // Set the class only at build time. All subsequent state is clocked by GSAP;
    // the +115% default leaves a fully visible plane beyond the transition.
    plane.classList.add('st-swept');
    plane.style.setProperty('--st-angle', angle + 'deg');
    plane.style.setProperty('--st-feather', spread + '%');
    from(plane, { '--st-edge': '-28%' }, { '--st-edge':'115%', duration:length, ease:'sine.inOut' }, at);
  };
  config.shots.slice(1).forEach((shot,i) => {
    const n=i+1, el=document.getElementById(shot.id);
    const plane=el.querySelector('.primary'), t=shot.start, d=shot.transitionFrames/config.fps;
    if (d<=0) return;
    if (n===3 || strength===0) {
      // Let the editor's overlap supply handles; this is deliberately a short match cut.
      const dt=Math.min(1.1/config.fps,d);
      tl.set(plane,{opacity:0},t);
      from(plane,{opacity:0},{opacity:1,duration:dt,ease:'sine.inOut'},t+(d-dt)*.5);
    } else if (n===5) {
      plane.classList.add('st-bloom-cut');
      from(plane,{'--st-edge':'-25%'},{'--st-edge':'115%',duration:d,ease:'sine.inOut'},t);
    } else {
      feather(plane,t,d,n===1?113:n===2?66:1,(n===4?7:13)*strength+3);
    }
    const optic=el.querySelector('.st-optic');
    if (optic && strength>0) {
      const peak=(n===2?.70:.48)*strength;
      if(n===2) from(optic,{'--st-light':'17%'},{'--st-light':'55%',duration:d,ease:'sine.inOut'},t);
      from(optic,{opacity:0},{opacity:peak,duration:d*.46,ease:'sine.out'},t);
      tl.to(optic,{opacity:0,duration:d*.54,ease:'sine.in'},t+d*.46);
    }
  });
  if (!config.settings.titles) return;
  const keys=['title','beat1','beat2','beat3','beat4','beat5'];
  config.cards.forEach((card,i) => {
    const wrap=document.getElementById('title-'+i);
    if(!wrap) return;
    const n=keys.indexOf(card.key), at=card.start, span=card.end-at;
    const rowEls=Array.from(wrap.querySelectorAll('.st-row'));
    const cells=Array.from(wrap.querySelectorAll('.st-ink'));
    if(!cells.length || span<=0) return;
    const enter=Math.min(.69,span*.44), exit=Math.min(.20,span*.18);
    const rule=wrap.querySelector('.st-rule');
    const fade=Math.min(.075,span*.10);
    // A single continuous envelope controls visibility in both seek directions.
    tl.to(wrap,{keyframes:[
      {opacity:1,duration:fade,ease:'none'},
      {opacity:1,duration:span-fade-exit,ease:'none'},
      {opacity:0,duration:exit,ease:'sine.in'}
    ],duration:span,ease:'none'},at);
    const byChar=(fn,fraction=.42) => cells.forEach((cell,k)=>{
      const q=cells.length===1?0:k/(cells.length-1);
      fn(cell,k,at+enter*fraction*q,enter*(1-fraction));
    });
    if(n===0) {
      byChar((cell,k,t,d)=>{
        from(cell,{y:(k%2?13:-12)*strength,opacity:.1},{y:0,opacity:1,duration:d*.64,ease:'power2.out'},t);
        from(cell,{'--st-fill':'-36%'},{'--st-fill':'106%',duration:d*.85,ease:'power2.out'},t+d*.15);
      });
      const note=wrap.querySelector('.st-note');
      if(note)from(note,{opacity:0},{opacity:1,duration:enter*.54,ease:'sine.out'},at+enter*.37);
    } else if(n===1) {
      byChar((cell,k,t,d)=>{
        const side=cell.closest('.st-row')===rowEls[0] ? 1 : -1;
        from(cell,{yPercent:side*(50+55*strength)},{yPercent:0,duration:d,ease:'power3.out'},t);
      },.39);
    } else if(n===2) {
      byChar((cell,k,t,d)=>from(cell,
        {clipPath:'polygon(-30% 0%,0% 0%,-27% 100%,-30% 100%)'},
        {clipPath:'polygon(-30% 0%,135% 0%,108% 100%,-30% 100%)',duration:d,ease:'sine.inOut'},t),.67);
    } else if(n===3) {
      byChar((cell,k,t,d)=>from(cell,{opacity:0,scaleY:.46,y:6*strength},
        {opacity:1,scaleY:1,y:0,duration:d,ease:'back.out(1.4)'},t),.72);
    } else if(n===4) {
      rowEls.forEach((row,k)=>from(row,{x:(k%2?1:-1)*(48+36*strength),opacity:0},
        {x:0,opacity:1,duration:enter*.7,ease:'power3.out'},at+(k===0?0:enter*.29)));
    } else {
      byChar((cell,k,t,d)=>from(cell,{rotationX:-84,opacity:.1},
        {rotationX:0,opacity:1,duration:d,ease:'power3.out'},t),.53);
    }
    from(rule,{scaleX:0},{scaleX:1,duration:enter*.63,ease:'power2.out'},at+enter*.28);
  });
}
