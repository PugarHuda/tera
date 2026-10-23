# Narration for the demo: one mp3 per scene (Microsoft neural voice via edge-tts) and its word timings for captions.
import asyncio, json, os, subprocess, sys
import edge_tts

VOICE = sys.argv[1] if len(sys.argv) > 1 else "en-US-AndrewMultilingualNeural"


async def scene(s):
    words = []
    with open(f"public/{s['id']}.mp3", "wb") as audio:
        async for chunk in edge_tts.Communicate(s["text"], VOICE, rate="+4%", boundary="WordBoundary").stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                # offsets are in 100 ns ticks
                words.append({"text": chunk["text"], "startMs": chunk["offset"] / 1e4, "endMs": (chunk["offset"] + chunk["duration"]) / 1e4})
    # Word boundaries carry bare words; take each word's spelling with its punctuation from the script.
    rest = s["text"]
    for w in words:
        i = rest.find(w["text"])
        if i < 0:
            continue
        j = i + len(w["text"])
        while j < len(rest) and not rest[j].isspace():
            j += 1
        w["text"], rest = rest[i:j], rest[j:]
    return {"id": s["id"], "words": words}


async def main():
    scenes = json.load(open("narration.json", encoding="utf-8"))
    out = [await scene(s) for s in scenes]
    json.dump(out, open("public/captions.json", "w", encoding="utf-8"), indent=1)
    # Each scene lasts as long as its narration (Demo.tsx reads audioMs); record.mjs adds its trim offsets to the same file.
    path = "public/scenes.json"
    manifest = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    for s in scenes:
        secs = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f"public/{s['id']}.mp3"], capture_output=True, text=True, check=True).stdout
        manifest.setdefault(s["id"], {})["audioMs"] = round(float(secs) * 1000)
    json.dump(manifest, open(path, "w", encoding="utf-8"), indent=1)


asyncio.run(main())
