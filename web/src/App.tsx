import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import "./App.css";

type ChipKind = "trip" | "msg" | "money" | "ghost" | "ping";

type Chip = {
  id: string;
  label: string;
  top: string;
  left?: string;
  right?: string;
  rotate: number;
  kind: ChipKind;
  from?: string;
  depth?: 1 | 2 | 3;
};

const SENDERS = ["bmt", "mit", "Binh Minh", "Dan Truong"] as const;

const POOL: Record<ChipKind, string[]> = {
  trip: [
    "Japan 2026",
    "Dublin 2010",
    "Madrid 2015",
    "Bali trip",
    "NYC weekend",
    "Seoul 2023",
    "Lisbon fall",
    "Tahoe cabin",
    "Mexico City",
    "Hanoi loop",
    "SF → LA",
    "Phuket??",
  ],
  msg: [
    "next Tuesday?",
    "Sat or Sun lol",
    "who's free tho",
    "send the link",
    "wait what time",
    "I'm down if y'all are",
    "can we move it",
    "bring snacks??",
  ],
  money: [
    "who's paying??",
    "venmo me when u can",
    "split 4 ways?",
    "I covered dinner",
    "$23 each?",
    "cashapp works",
    "tab is wild",
    "owe you from last time",
  ],
  ping: [
    "we still on??",
    "bowling???",
    "hello???",
    "anyone awake",
    "vote now pls",
    "locking in 10min",
    "??? where r u",
    "last call",
  ],
  ghost: [
    "Madrid 2015",
    "Seoul 2023",
    "I'll pay you back",
    "maybe next week",
    "rain check :/",
    "we never booked",
    "forgot again",
    "soon™",
  ],
};

/** Mirrored left/right slots — labels/senders fill in per refresh. */
const SLOTS: Omit<Chip, "id" | "label" | "from">[] = [
  { top: "12%", left: "8%", rotate: -7, kind: "trip", depth: 2 },
  { top: "12%", right: "8%", rotate: 7, kind: "trip", depth: 2 },
  { top: "22%", left: "6%", rotate: 4, kind: "msg", depth: 2 },
  { top: "22%", right: "6%", rotate: -4, kind: "msg", depth: 2 },
  { top: "18%", left: "26%", rotate: -3, kind: "ping", depth: 1 },
  { top: "18%", right: "26%", rotate: 3, kind: "ping", depth: 1 },
  { top: "34%", left: "4%", rotate: -5, kind: "money", depth: 1 },
  { top: "34%", right: "4%", rotate: 5, kind: "money", depth: 1 },
  { top: "42%", left: "10%", rotate: 3, kind: "ghost", depth: 3 },
  { top: "42%", right: "10%", rotate: -3, kind: "ghost", depth: 3 },
  { top: "56%", left: "7%", rotate: -4, kind: "trip", depth: 2 },
  { top: "56%", right: "7%", rotate: 4, kind: "money", depth: 2 },
  { top: "68%", left: "9%", rotate: 5, kind: "msg", depth: 1 },
  { top: "68%", right: "9%", rotate: -5, kind: "ghost", depth: 2 },
  { top: "82%", left: "16%", rotate: -3, kind: "ghost", depth: 3 },
  { top: "82%", right: "16%", rotate: 3, kind: "trip", depth: 2 },
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Fresh labels + senders each page load; layout slots stay put. */
function dealChips(): Chip[] {
  const used = new Set<string>();
  const take = (kind: ChipKind) => {
    const options = shuffle(POOL[kind].filter((l) => !used.has(`${kind}:${l}`)));
    const label = options[0] ?? pick(POOL[kind]);
    used.add(`${kind}:${label}`);
    return label;
  };

  return SLOTS.map((slot, i) => {
    const label = take(slot.kind);
    const needsFrom = slot.kind !== "trip" && Math.random() > 0.18;
    return {
      ...slot,
      id: `${i}-${label}`,
      label,
      from: needsFrom ? pick(SENDERS) : undefined,
    };
  });
}

type Floater = {
  id: number;
  kind: "petal" | "bloom";
  left: string;
  delay: number;
  duration: number;
  size: number;
  drift: number;
  spin: number;
  tone: 1 | 2 | 3;
  depth: 1 | 2 | 3;
  side: -1 | 1;
};

/** Mirrored pairs so left/right stay balanced. */
const FLOATERS: Floater[] = Array.from({ length: 11 }, (_, i) => {
  const leftPos = 4 + i * 3.8; // 4% → ~42%
  const kind = i % 4 === 0 ? "bloom" : "petal";
  const size = kind === "bloom" ? 22 + (i % 3) * 5 : 12 + (i % 5) * 3.5;
  const duration = 8 + (i % 5) * 1.4;
  const drift = 48 + (i % 4) * 28;
  const tone = ((i % 3) + 1) as 1 | 2 | 3;
  const depth = ((i % 3) + 1) as 1 | 2 | 3;
  const base = {
    kind: kind as "petal" | "bloom",
    duration,
    size,
    drift,
    tone,
    depth,
  };
  return [
    {
      ...base,
      id: i * 2,
      left: `${leftPos}%`,
      delay: i * 0.55,
      spin: i % 2 === 0 ? 280 : -300,
      side: -1 as const,
    },
    {
      ...base,
      id: i * 2 + 1,
      left: `${100 - leftPos}%`,
      delay: i * 0.55 + 0.28,
      spin: i % 2 === 0 ? -280 : 300,
      side: 1 as const,
    },
  ];
}).flat();

function SakuraPetal({ tone }: { tone: 1 | 2 | 3 }) {
  return (
    <svg viewBox="0 0 28 48" aria-hidden className={`sakura__svg sakura__svg--t${tone}`}>
      <path d="M14 1.5C20 1.5 26 9 26.5 20c.5 10-5.5 20-12.5 26.5C7 40 1 30 1.5 20 2 9 8 1.5 14 1.5Z" />
      <path
        d="M14 10c0 8-.2 16-.8 24"
        fill="none"
        stroke="rgba(255,255,255,0.32)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SakuraBloom({ tone }: { tone: 1 | 2 | 3 }) {
  // almond petal pointing up from the flower center
  const petal = "M20 20C22.5 13 25 7 20 3.5 15 7 17.5 13 20 20Z";
  return (
    <svg viewBox="0 0 40 40" aria-hidden className={`sakura__svg sakura__svg--t${tone}`}>
      {[0, 72, 144, 216, 288].map((deg) => (
        <path key={deg} d={petal} transform={`rotate(${deg} 20 20)`} />
      ))}
      <circle cx="20" cy="20" r="2.6" className="sakura__center" />
    </svg>
  );
}

export default function App() {
  const heroRef = useRef<HTMLElement>(null);
  const [chips] = useState(dealChips);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from(".hero__brand", {
        y: 36,
        opacity: 0,
        duration: 0.9,
        ease: "power3.out",
      });
      gsap.from(".hero__slogan", {
        y: 20,
        opacity: 0,
        duration: 0.8,
        delay: 0.15,
        ease: "power3.out",
      });
      gsap.fromTo(
        ".float-chip",
        { opacity: 0, scale: 0.88, filter: "blur(4px)" },
        {
          opacity: 1,
          scale: 1,
          filter: "blur(0px)",
          duration: 0.7,
          stagger: 0.07,
          delay: 0.4,
          ease: "power2.out",
          clearProps: "filter",
        },
      );

      gsap.utils.toArray<HTMLElement>(".float-chip").forEach((chip, i) => {
        const rot = parseFloat(getComputedStyle(chip).getPropertyValue("--rot")) || 0;
        gsap.set(chip, { rotation: rot });
        gsap.to(chip, {
          y: i % 2 === 0 ? "+=14" : "-=16",
          x: i % 3 === 0 ? "+=8" : "-=6",
          rotation: rot + (i % 2 === 0 ? 3 : -3),
          duration: 3.2 + (i % 5) * 0.45,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
          delay: 0.6 + i * 0.08,
        });
      });

      gsap.utils.toArray<HTMLElement>(".sakura").forEach((el) => {
        const drift = parseFloat(el.dataset.drift || "60");
        const spin = parseFloat(el.dataset.spin || "200");
        const duration = parseFloat(el.dataset.duration || "12");
        const delay = parseFloat(el.dataset.delay || "0");
        const depth = parseFloat(el.dataset.depth || "2");
        const dir = parseFloat(el.dataset.side || "1");
        const peakOpacity = depth === 1 ? 0.9 : depth === 2 ? 0.7 : 0.45;

        gsap.set(el, {
          y: -60 - Math.random() * 100,
          x: 0,
          opacity: 0,
          rotation: Math.random() * 80 - 40,
          scale: depth === 1 ? 1.05 : depth === 3 ? 0.75 : 0.9,
          filter: depth === 3 ? "blur(1.2px)" : "none",
        });

        const tl = gsap.timeline({ repeat: -1, delay });
        tl.to(el, { opacity: peakOpacity, duration: 1.1, ease: "sine.out" })
          .to(
            el,
            {
              y: "115vh",
              duration,
              ease: "none",
            },
            0,
          )
          .to(
            el,
            {
              x: dir * drift,
              duration: duration * 0.5,
              ease: "sine.inOut",
              yoyo: true,
              repeat: 1,
            },
            0,
          )
          .to(
            el,
            {
              rotation: `+=${spin}`,
              duration,
              ease: "sine.inOut",
            },
            0,
          )
          .to(el, { opacity: 0, duration: 1.5, ease: "sine.in" }, duration - 1.5);
      });
    }, heroRef);

    const reveals = gsap.utils.toArray<HTMLElement>(".reveal");
    const onScroll = () => {
      reveals.forEach((el) => {
        const top = el.getBoundingClientRect().top;
        if (top < window.innerHeight * 0.88) el.classList.add("is-in");
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const storyCtx = gsap.context(() => {
      gsap.from(".imessage .bubble", {
        opacity: 0,
        y: 12,
        duration: 0.45,
        stagger: 0.12,
        ease: "power2.out",
        delay: 0.35,
      });
    });

    return () => {
      window.removeEventListener("scroll", onScroll);
      ctx.revert();
      storyCtx.revert();
    };
  }, []);

  return (
    <div className="page">
      <div className="page__grain" aria-hidden />

      <section className="hero" ref={heroRef}>
        <div className="hero__blush" aria-hidden />
        <div className="sakura-field" aria-hidden>
          {FLOATERS.map((p) => (
            <span
              key={p.id}
              className={`sakura sakura--${p.kind} sakura--d${p.depth}`}
              data-drift={p.drift}
              data-spin={p.spin}
              data-duration={p.duration}
              data-delay={p.delay}
              data-depth={p.depth}
              data-side={p.side}
              style={
                {
                  left: p.left,
                  "--sakura-size": `${p.size}px`,
                } as React.CSSProperties
              }
            >
              {p.kind === "bloom" ? (
                <SakuraBloom tone={p.tone} />
              ) : (
                <SakuraPetal tone={p.tone} />
              )}
            </span>
          ))}
        </div>

        <div className="float-field" aria-hidden>
          {chips.map((g) => (
            <div
              key={g.id}
              className={`float-chip float-chip--${g.kind} float-chip--d${g.depth ?? 2}`}
              style={
                {
                  top: g.top,
                  left: g.left,
                  right: g.right,
                  ["--rot"]: `${g.rotate}deg`,
                } as React.CSSProperties
              }
            >
              {g.from ? <span className="float-chip__from">{g.from}</span> : null}
              <span className="float-chip__text">{g.label}</span>
            </div>
          ))}
        </div>

        <div className="hero__copy">
          <h1 className="hero__brand">mi amigo</h1>
          <p className="hero__slogan">gettin' out of the group chat</p>
        </div>
      </section>

      <section className="story" id="about">
        <div className="story__block story__block--thesis reveal">
          <h2 className="story__title">Bowling dies in the chat. Nobody ever pays you back.</h2>
          <p className="story__lead">
            You know how it goes. “this weekend?” sits there for three days. Dinner hits your card
            and the chase starts next week. mi amigo just… finishes it.
          </p>
        </div>

        <div className="story__block story__block--chaos reveal">
          <h2 className="story__title story__title--sm">Yeah. This thread.</h2>
          <div className="chaos" aria-hidden>
            {[
              "bowling this weekend???",
              "Sat or Sun lol",
              "who's free tho",
              "we still on??",
              "wait what time",
              "maybe next week",
              "who's paying??",
              "split 4 ways?",
              "venmo me when u can",
              "I'll pay you back",
              "hello???",
              "rain check :/",
            ].map((line) => (
              <span key={line} className="chaos__chip">
                {line}
              </span>
            ))}
          </div>
        </div>

        <div className="story__block reveal">
          <h2 className="story__title story__title--sm">Same bros. Different ending.</h2>
          <p className="story__lead story__lead--tight">
            mi amigo only chimes in when something’s about to drift — then it’s gone again.
          </p>
          <div className="imessage" aria-label="Sample group chat with mi amigo">
            <div className="imessage__bar">
              <div className="imessage__people" aria-hidden>
                <span>b</span>
                <span>m</span>
                <span>D</span>
                <span>B</span>
              </div>
              <div className="imessage__meta">
                <span className="imessage__title">bros</span>
                <span className="imessage__sub">iMessage</span>
              </div>
            </div>
            <div className="imessage__thread">
              <p className="imessage__stamp">Wednesday 8:14 PM</p>

              <div className="bubble bubble--them">
                <span className="bubble__from">bmt</span>
                bowling this weekend???
              </div>
              <div className="bubble bubble--them">
                <span className="bubble__from">mit</span>
                down — Sat or Sun lol
              </div>
              <div className="bubble bubble--them">
                <span className="bubble__from">Dan Truong</span>
                ig either
              </div>

              <div className="bubble bubble--amigo">
                <span className="bubble__from">mi amigo</span>
                bet which one
              </div>

              <div className="poll" aria-label="iMessage poll">
                <p className="poll__label">Poll</p>
                <div className="poll__choice poll__choice--win">
                  <div className="poll__bar" style={{ width: "100%" }} />
                  <div className="poll__row">
                    <span className="poll__text">Sat 7pm</span>
                    <div className="poll__voters" aria-hidden>
                      <span className="poll__face poll__face--1">b</span>
                      <span className="poll__face poll__face--2">m</span>
                      <span className="poll__face poll__face--3">D</span>
                      <span className="poll__face poll__face--4">B</span>
                    </div>
                  </div>
                </div>
                <div className="poll__choice poll__choice--lose">
                  <div className="poll__bar" style={{ width: "28%" }} />
                  <div className="poll__row">
                    <span className="poll__text">Sun 6pm</span>
                  </div>
                </div>
              </div>

              <div className="bubble bubble--amigo">
                <span className="bubble__from">mi amigo</span>
                sat 7 we in
              </div>

              <p className="imessage__stamp">Saturday 10:41 PM</p>

              <div className="bubble bubble--them">
                <span className="bubble__from">bmt</span>
                that was fun. dinner was $120 on me
              </div>
              <div className="bubble bubble--them">
                <span className="bubble__from">mit</span>
                chase??
              </div>

              <div className="bubble bubble--amigo">
                <span className="bubble__from">mi amigo</span>
                $30 each to bmt
              </div>
            </div>
          </div>
        </div>

        <div className="story__block reveal">
          <h2 className="story__title story__title--sm">Same weekend tho.</h2>
          <div className="compare">
            <div className="compare__col compare__col--bad">
              <p className="compare__label">usual</p>
              <div className="compare__thread">
                <p>
                  <strong>Wed</strong> sat or sun…?
                </p>
                <p>
                  <strong>Fri</strong> we still on??
                </p>
                <p>
                  <strong>Sun</strong> so about bowling
                </p>
                <p className="compare__fade">still waiting on that $30</p>
              </div>
            </div>
            <div className="compare__col compare__col--good">
              <p className="compare__label">w/ mi amigo</p>
              <div className="compare__thread">
                <p>
                  <strong>Wed</strong> sat 7 locked
                </p>
                <p>
                  <strong>Sat</strong> actually went
                </p>
                <p>
                  <strong>Sat night</strong> $30 each, done
                </p>
                <p className="compare__win">chat’s quiet again</p>
              </div>
            </div>
          </div>
        </div>

        <div className="story__block story__block--steps reveal">
          <h2 className="story__title story__title--sm">That’s kinda it.</h2>
          <ol className="steps">
            <li>
              <span className="steps__n">1</span>
              <div>
                <h3>Add the number</h3>
                <p>Throw mi amigo in the group like anyone else.</p>
              </div>
            </li>
            <li>
              <span className="steps__n">2</span>
              <div>
                <h3>Talk normal</h3>
                <p>Plans, money, whatever. No slash commands.</p>
              </div>
            </li>
            <li>
              <span className="steps__n">3</span>
              <div>
                <h3>It closes the loop</h3>
                <p>Locks the night. Splits the tab. Then shuts up.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <footer className="footer">
        <p>
          <strong>mi amigo</strong> · gettin' out of the group chat
        </p>
      </footer>
    </div>
  );
}
