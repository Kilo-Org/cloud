# mobile e2e evidence: sips --cropOffset is unreliable for header crops — use PIL

Symptom: cropping the header strip out of a 1206x2622 simctl screenshot with
`sips -c 340 1206 --cropOffset 0 0 in.png --out out.png` returns a center-crop
(ignores the offset) or an all-black image (offset overshoots).

Cause: sips `-c` crops centered; `--cropOffset` semantics are unclear/buggy on
current macOS (observed July 2026).

Fix: `python3 -c` with PIL (`import PIL` works on this machine's python3):
`Image.open(p).crop((0,0,w,340)).save(out)`. Deterministic, exact pixel regions,
and cheap downscales (`resize((w//2, h//2))`) keep evidence small for reports.
