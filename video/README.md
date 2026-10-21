# Demo video

The demo is built from code: the live app recorded by Playwright, narrated by a neural voice, and assembled by Remotion with captions that follow the voice word by word.

```sh
cd video && npm ci
pip install edge-tts==7.3.1
npm run tts        # narration.json -> public/<scene>.mp3 + public/captions.json (word timings, Microsoft neural voice)
npm run record     # Playwright drives the production app, paced to the narration -> public/<scene>.webm + scenes.json
npm run render     # Remotion -> out/tera-demo.mp4
```

- **Script:** `narration.json`, one entry per scene.
- **Timing:** each action in `record.mjs` waits for its word in the narration (`at("credits")`), so the highlight lands as the voice says it.
- **Assets:** `public/suite-ui.png` is a screenshot of the TestSprite portal, which needs a login and cannot be recorded headless.
