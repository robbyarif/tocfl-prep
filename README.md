# TOCFL listening replay

A Tampermonkey userscript (`tocfl-listening.user.js`) for the 華測會 CATO TOCFL practice test at `https://cbt.sc-top.org.tw/cato/*`.

## Features

- **Replay button**: adds a "重播 Replay" button under the page heading when a question's listening audio is on the page. Clicking it rewinds to the start and plays the clip again.
- **Drag to seek**: press or drag on the playback progress bar (`#MediaDurationBar`) to jump to that point. Works on question audio and on the briefing video.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in the Chrome profile you use for the test.
2. Open the Tampermonkey dashboard, create a new script, paste in the contents of `tocfl-listening.user.js`, and save (Ctrl+S).
3. In Chrome's extension settings for Tampermonkey, turn on **Allow User Scripts**. Without this the script is saved and enabled but does not run.
4. Reload the CATO test page.

## Known issues

- Drag-to-seek has been checked in code but not with a real drag. The site may have handlers on the bar that interfere.
- The progress bar's fill is driven by the site and may not match the media's position after a drag. The drag may move the audio while the bar stays stale.
- The Replay button is added only when question audio is on the page, so it does not appear on the briefing screen.

## Decisions (not to revisit without a new reason)

- The script does not change the site's reading countdown (`#TimeCountDown`). This is an official test platform, and changing its timing was declined.
- No OCR overlay on the exam page's images. Declined for the same reason.

## Open ideas

- An OCR tool for user-supplied material (screenshots of study sheets, textbook pages) was offered and remains open.
- A separate, user-controlled practice timer that does not touch the site was offered and remains open.

## Files

- `tocfl-listening.user.js`: the userscript.
- `README.md`: this file.
