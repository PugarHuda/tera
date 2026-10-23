// The Tera demo: Playwright recordings of the live app (record.mjs), neural narration with word timings (tts.py),
// and burned-in captions that follow the voice.
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, Series, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import captions from "../public/captions.json";
import manifest from "../public/scenes.json";

export const FPS = 30;
const ACCENT = "#f6a04a";
const PAD_MS = 700;

type Word = { text: string; startMs: number; endMs: number };
type Id = keyof typeof manifest;
const SCENES: { id: Id; kind: "video" | "image" | "card"; label: string }[] = [
  { id: "intro", kind: "video", label: "tera-orpin-three.vercel.app" },
  { id: "simulator", kind: "video", label: "Simulator · golden scenario S05" },
  { id: "edit", kind: "video", label: "Simulator · live edits" },
  { id: "parity", kind: "video", label: "/parity · real Stripe test clocks" },
  { id: "builder", kind: "video", label: "Pricing builder · migration planner" },
  { id: "agents", kind: "video", label: "MCP server · OpenAPI reference" },
  { id: "loop", kind: "video", label: "PR #18 · TestSprite check" },
  { id: "suite", kind: "image", label: "TestSprite portal · Tera UI" },
  { id: "outro", kind: "card", label: "Every pull request" },
];
const frames = (ms: number) => Math.round((ms / 1000) * FPS);
const sceneFrames = (id: Id) => frames(manifest[id].audioMs + PAD_MS);
export const totalFrames = SCENES.reduce((n, s) => n + sceneFrames(s.id), 0);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const Demo = () => (
  <AbsoluteFill style={{ background: "#0d0d0d", fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif" }}>
    <Series>
      {SCENES.map((s) => (
        <Series.Sequence key={s.id} durationInFrames={sceneFrames(s.id)}>
          <Scene {...s} />
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);

function Scene({ id, kind, label }: (typeof SCENES)[number]) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = interpolate(frame, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], clamp);
  const words = (captions.find((c) => c.id === id)?.words ?? []) as Word[];
  const trimMs = (manifest[id] as { trimMs?: number }).trimMs ?? 0;
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      {kind === "video" && <OffthreadVideo src={staticFile(`${id}.webm`)} trimBefore={frames(trimMs)} muted />}
      {kind === "image" && <Portal />}
      {kind === "card" && <Outro />}
      {id === "intro" && <Title />}
      <Chip label={label} />
      <Captions words={words} />
      <Audio src={staticFile(`${id}.mp3`)} />
    </AbsoluteFill>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <div style={{ position: "absolute", top: 18, right: 18, padding: "6px 14px", borderRadius: 999, background: "rgba(13,13,13,.85)", color: "#eee", fontSize: 17, border: `1px solid ${ACCENT}` }}>
      {label}
    </div>
  );
}

function Title() {
  const o = interpolate(useCurrentFrame(), [0, 10, 95, 115], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: `rgba(10,10,10,${0.9 * o})`, justifyContent: "center", alignItems: "center", opacity: o }}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 120, color: "#fff" }}>Tera</div>
      <div style={{ fontSize: 34, color: ACCENT, marginTop: 8 }}>Every invoice, to the cent, before your customers see it</div>
      <div style={{ fontSize: 22, color: "#bbb", marginTop: 18 }}>A Stripe-parity billing simulator · TestSprite Hackathon Season 4</div>
    </AbsoluteFill>
  );
}

function Portal() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scale = interpolate(frame, [0, durationInFrames], [1, 1.1]);
  const stats = ["28 UI tests + API tests on each PR preview", "Exact hand-derived amounts", "Red check → failure bundle × Stripe triage", "Nightly money-math canary on production", "Plans and code: repo = cloud, drift fails CI"];
  return (
    <AbsoluteFill>
      <Img src={staticFile("suite-ui.png")} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})`, transformOrigin: "60% 30%" }} />
      <div style={{ position: "absolute", left: 40, top: 110, display: "flex", flexDirection: "column", gap: 12 }}>
        {stats.map((s, i) => {
          const o = interpolate(frame, [30 + i * 75, 45 + i * 75], [0, 1], clamp);
          return (
            <div key={s} style={{ opacity: o, transform: `translateX(${(1 - o) * -30}px)`, background: "rgba(13,13,13,.92)", color: "#fff", padding: "10px 18px", borderRadius: 10, fontSize: 26, borderLeft: `5px solid ${ACCENT}` }}>
              {s}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function Outro() {
  const frame = useCurrentFrame();
  const items = [
    "TestSprite: UI + API tests on the PR preview, required for admins too",
    "PR #40: a planted one-cent bug, refused by every required check",
    "Playwright user journeys + axe WCAG 2.2 AA",
    "Schemathesis API fuzzing · Arazzo workflows · Redocly lint",
    "Lighthouse budgets: accessibility, SEO, CLS",
    "Nightly: differential fuzzing against Stripe",
    "Nightly: Stryker mutation testing, 87.6%",
  ];
  const end = interpolate(frame, [frames(13600), frames(14300)], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ background: "radial-gradient(circle at 30% 20%, #2a1407, #0d0d0d 70%)", padding: "70px 90px" }}>
      <div style={{ opacity: 1 - end, fontFamily: "Georgia, serif", fontSize: 56, color: "#fff", marginBottom: 28 }}>Every pull request</div>
      {items.map((s, i) => (
        <div key={s} style={{ opacity: interpolate(frame, [15 + i * 38, 30 + i * 38], [0, 1], clamp) * (1 - end), fontSize: 30, color: "#eee", margin: "8px 0" }}>
          <span style={{ color: ACCENT }}>✓</span> {s}
        </div>
      ))}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: end }}>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 110, color: "#fff" }}>Tera</div>
        <div style={{ fontSize: 30, color: ACCENT }}>tera-orpin-three.vercel.app</div>
        <div style={{ fontSize: 24, color: "#bbb", marginTop: 10 }}>github.com/PugarHuda/tera</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// Lines of up to 7 words, broken after punctuation; the word being spoken is highlighted.
function Captions({ words }: { words: Word[] }) {
  const ms = (useCurrentFrame() / FPS) * 1000;
  const lines: Word[][] = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (!last || last.length >= 7 || (last.length >= 3 && /[.,:;!?]$/.test(last.at(-1)!.text))) lines.push([w]);
    else last.push(w);
  }
  const line = lines.findLast((l) => l[0].startMs <= ms);
  if (!line || ms > line.at(-1)!.endMs + 1200) return null;
  return (
    <div style={{ position: "absolute", bottom: 40, width: "100%", display: "flex", justifyContent: "center" }}>
      <div style={{ background: "rgba(0,0,0,.8)", padding: "10px 22px", borderRadius: 12, fontSize: 36, fontWeight: 600, color: "#fff", maxWidth: 1100, textAlign: "center" }}>
        {line.map((w, i) => (
          <span key={i} style={{ color: ms >= w.startMs && ms < (line[i + 1]?.startMs ?? w.endMs + 400) ? ACCENT : "#fff" }}>
            {w.text}{" "}
          </span>
        ))}
      </div>
    </div>
  );
}
