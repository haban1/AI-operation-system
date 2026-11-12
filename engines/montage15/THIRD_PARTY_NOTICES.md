# Third-party notices

## Five original montage compositions (2026-11-10)

`src/montage15.mjs` and `templates/montage15/catalog.json` implement original
parameterized 15-second compositions. They use numbered CSS color cards and
system fonts. No commercial template source, project archive, preview footage,
music, logo, or font file is included in these five compositions.

The following publicly viewable products were references for visual techniques,
not sources of project code or reusable media, and are not declared open source:

- Perspective Flow — GR-44 Seamless Transitions: https://videohive.net/item/seamless-transitions-for-davinci-resolve/33184639
- Prism Pulse — Lazy Pack: https://buymeacoffee.com/lazyartist89/e/582242
- Film Strip — Film Cinematic Opener: https://motionarray.com/premiere-pro-templates/film-cinematic-opener-3467667/
- Focus Story — The Slideshow: https://videohive.net/item/the-slideshow/60982546
- Split Journey — Holiday Travel Opener: https://mixkit.co/free-after-effects-templates/holiday-travel-opener-839/
- Text/rhythm reference — Energy Sport Opener: https://motionarray.com/premiere-pro-templates/energy-sport-opener-324655/

The implementation covers the techniques described in README, not every
preset or advanced feature advertised by these products. The references do
not imply endorsement or ownership of their assets.

## HyperFrames template source and adaptations

The `play-mode` and `warm-grain` candidates derive from the corresponding
examples in [HeyGen HyperFrames](https://github.com/heygen-com/hyperframes),
licensed under the Apache License, Version 2.0. The downloaded, unmodified
entry sources and license are retained in `templates/upstream/`; `sources.json`
records their URLs, download time, lengths, and SHA-256 hashes.

Sources:

- https://github.com/heygen-com/hyperframes/tree/main/registry/examples/play-mode
- https://github.com/heygen-com/hyperframes/tree/main/registry/examples/warm-grain

The workbench changes the original landscape compositions into self-contained
1080 × 1920, 30 fps, 15-second compositions with three five-second media slots.
The adaptation rebuilds layout, timing, captions, media binding, and preview
controls; it retains the blue/white framed style of Play Mode and the cream
paper/framed style of Warm Grain. These are derived candidate templates,
awaiting acceptance with the user's actual materials. They are not an unchanged
import of all upstream scenes and are not approved production templates.

The full Apache-2.0 license is at `templates/upstream/LICENSE.hyperframes.txt`.
Upstream source attribution and this description of modifications must remain
with redistributed adaptations. Apache-2.0 does not grant trademark rights or
automatically license media, fonts, or dependencies owned by other parties.

## HyperFrames rendering software

The runtime dependency `hyperframes` is distributed under Apache-2.0. Its
own dependencies and accompanying notices retain their respective terms.
The local workbench uses the installed CLI; it does not claim rights to any
HeyGen brand assets, promotional media, or cloud service.

## GSAP

The workbench uses GSAP 3.14.2, served locally from the installed npm package.
GSAP has its own Standard "no charge" license, as declared by that package:
https://gsap.com/standard-license.

GSAP is not relicensed under Apache-2.0 by this project. Retain its copyright
and license notices when distributing the dependency. No statement in this
file expands the permissions granted by GSAP's license.

## Fonts, textures, and user media

The adapted templates reference system font families (including macOS Chinese
font families) and do not bundle font files. Their exact rendering depends on
fonts available on the host. The original templates' Google Fonts URL and
Transparent Textures paper image are not loaded or distributed by the adapted
templates. The paper treatment in the adaptation uses a static CSS pattern.

No original upstream promotional footage, commercial preview soundtrack,
commercial font, or logo is included. Example slots are visibly labeled
placeholders. User-imported video, images and audio retain their owners' rights.
Original clip sound is muted in preview and export.

## Built-in music and transition sound design

Five 15-second adapted excerpts by Kevin MacLeod (incompetech.com) are included:
Newer Wave, Voltaic, Chill Wave, Dream Culture, and Nowhere Land. These are
licensed under Creative Commons Attribution 4.0, not under the workbench code's
license. Retain the author, original track URL, license URL and modification
notice when using or sharing the music or a resulting video. Full credits and
excerpt/tempo changes are in templates/montage15/audio/CREDITS.md.

License: https://creativecommons.org/licenses/by/4.0/
Official licensing: https://incompetech.com/music/royalty-free/licenses/

The transition SFX stems were synthesized for this workbench. They contain no
audio extracted from the commercial reference previews. Original reference
soundtrack availability is documented separately in
templates/montage15/audio/SOURCES.md.
