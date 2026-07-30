# mobile: file-navigator formSheet renders clipped on iOS 26 simulator — filter unreachable visually

Symptom: the PR-review file-navigator sheet (`/(app)/pr-review/[o]/[r]/[n]/file-navigator`, opened via the Files tab "Open file navigator" header or a deep link) shows ONLY the file rows under the grabber — the ScreenHeader, the "Filter files by path" input, and the viewed-counter are not on screen. Yet the a11y tree CONTAINS the filter (driver waits/taps on 'Filter files by path' succeed), and row bounds overlap the grabber bounds (e.g. row1 y=466 vs grabber 455–479), i.e. the content is laid out shifted up, top section clipped. A tap on the filter's a11y frame lands on whatever is visually at those coordinates (it expanded a file row on the underlying tab).

Cause: unresolved — an iOS 26 RN sheet/Modal presentation-family a11y/pixel divergence (the hierarchy contains chrome that is not on screen). Not caused by the `leading-[normal]` sweep: the clipped region includes non-input chrome (header, counter) and the sweep only removes TextInput lineHeight. Reproduced on both the deep-link and the UI paths on head 3a29c371f.

Fix: none found this round. Visual verification of the navigator filter placeholder baseline/clipping is impossible while the clip persists; future rounds should check whether a full detent, a real device, or an iOS 18 simulator renders the sheet fully.
