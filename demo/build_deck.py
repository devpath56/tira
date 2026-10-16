#!/usr/bin/env python3
"""Build index.html: keyboard-operable D2 demo deck with storytelling.

Structure: global intro -> per scenario: story card -> chart boards.
Every chart board pairs its caption with system-vs-chat-only contrast.
Story cards are presenter-voice narratives: the situation, without the
system, with the system.
"""
import glob
import html
import os
import re
import subprocess

DEMO = os.path.dirname(os.path.abspath(__file__))

SCENARIOS = [
    ("s1", "s1-interruption.d2", "S1 · The Interruption"),
    ("s2", "s2-done-without-proof.d2", "S2 · Done Without Proof"),
    ("s7", "s7-false-finish.d2", "S7 · The False Finish"),
    ("s3", "s3-backtrack.d2", "S3 · The Backtrack"),
    ("s5", "s5-vapor-catch.d2", "S5 · The Vapor Catch"),
    ("s9", "s9-escalation.d2", "S9 · The Escalation"),
    ("s8", "s8-whats-next.d2", "S8 · What's Next"),
    ("s6", "s6-honest-undo.d2", "S6 · Honest Undo (interlude)"),
    ("s4", "s4-scope-creep.d2", "S4 · Scope Creep Denied (interlude)"),
]

INTRO = {
    "kicker": "Before we begin",
    "title": "The situation",
    "body": [
        "You\u2019re building a dashboard \u2014 a metrics card, a table, filters. "
        "The work is a tree: epics break into stories, stories into features, features into tasks. "
        "You work depth-first: pick a branch, go deep, backtrack when it drains.",

        "New tasks surface mid-work. A dependency you didn\u2019t know about. "
        "An idea mentioned in chat at 11pm. A task that turns out to be unnecessary.",

        "Right now, all of this lives in chat \u2014 scattered messages and your own memory. "
        "Nothing records what state anything is in. Nothing proves what happened. "
        "And when you ask \u201cwhat now?\u201d, the only answer is your best recollection.",

        "This demo walks through 9 moments where that breaks \u2014 each one as a story first, "
        "then the machine. Press n.",
    ],
}

# STORIES[scenario_id] = (imagine, without_system, with_system)
STORIES = {
    "s1": (
        "You\u2019re deep in the colors task, tuning the palette, when you realize it depends "
        "on a design-token decision nobody has made yet.",
        "You context-switch to tokens. The colors thread decays in your head. When tokens are done, "
        "you stare at the screen thinking: \u201cwait, what was I doing?\u201d",
        "The interruption is recorded \u2014 block, resolve the dependency as tracked work, unblock \u2014 "
        "and the cursor returns to exactly where you left off. Watch it happen:",
    ),
    "s2": (
        "You\u2019re finishing the loading state, and you type \u201cdone\u201d.",
        "Done is a message you send. Nobody checks. The proof was never attached, "
        "and the claim is now fact.",
        "Done is a verdict the machine issues \u2014 and it refuses to issue it without evidence. "
        "Watch the guard fire:",
    ),
    "s7": (
        "Halfway through the font task you realize the design system already covers it. "
        "The task shouldn\u2019t exist.",
        "You just\u2026 stop. The task sits \u201cin progress\u201d forever, quietly holding its parent "
        "hostage \u2014 nobody knows if it was done or abandoned.",
        "You cancel it \u2014 a terminal verdict, on the record, distinct from done and from forgetting. "
        "And the parent drains anyway. Watch:",
    ),
    "s3": (
        "You\u2019ve finished everything under \u201cimprove visual\u201d. Now what?",
        "You scroll up through the chat, reconstruct what\u2019s done from memory, and ask the most "
        "expensive question in knowledge work: \u201cwhat was I doing?\u201d",
        "The drain is computed, the tree climbs itself, and replay derives exactly one answer. "
        "Watch the cursor land:",
    ),
    "s5": (
        "It\u2019s 11pm and someone mentions the Table needs server-side pagination. "
        "Good idea \u2014 and everyone\u2019s about to sleep.",
        "That\u2019s where 90% of ideas live and die \u2014 a good sentence, then nothing. "
        "Three months later it\u2019s a surprise, or it never resurfaces.",
        "The sentence is declared as a claim; the system drafts the file record and proposes where it belongs. "
        "You just approve \u2014 twice. Watch vapor become a node, driven not remembered:",
    ),
    "s9": (
        "You declared a claim \u2014 CSV export \u2014 and then life happened. Three days, no approval.",
        "The draft sits in a doc nobody opens. The idea dies not with a bang but with a shrug \u2014 "
        "nobody is even told it stalled.",
        "The claim was in the log, aging. At the SLA the breach predicate fires \u2014 it refuses to die "
        "quietly. You approve late and the pipeline resumes. Watch:",
    ),
    "s8": (
        "You just completed something. Momentum is high. What now?",
        "You have to remember to ask. Advice arrives as \u201cyou should probably do X\u201d \u2014 "
        "uncheckable, unreproducible.",
        "The suggestion arrives on its own \u2014 with receipts: what triggered it, which rule picked it, "
        "what it rejected and why. Watch:",
    ),
    "s6": (
        "Review catches it: colors shipped the wrong palette. It was marked done yesterday.",
        "\u201cActually that\u2019s not done.\u201d History rewrites itself; the why evaporates; "
        "which palette shipped becomes unknowable.",
        "Even undo needs a reason. The reversal is an event in the log \u2014 done, back to in_progress, "
        "done again with new proof. Watch an honest undo:",
    ),
    "s4": (
        "Someone says \u201cwhile you\u2019re in there, add caching to fetch_metrics\u201d \u2014 "
        "a branch that\u2019s been done for a week.",
        "It just appears in the plan. Nobody decided it; scope grew as a side effect.",
        "A finished branch is sealed. New scope is refused until someone explicitly re-opens it \u2014 "
        "with a reason, on the record. Watch scope creep get denied:",
    ),
}

# CONTENT[scenario_id][board_index] = (buys, chat). Board 0 = root.
CONTENT = {
    "s1": [
        ("One tree, one cursor, every state visible at a glance.",
         "Your plan is scattered across messages; \u201cwhere was I?\u201d is a scroll away."),
        ("The blocker is a first-class event with a named cause \u2014 not a feeling.",
         "\u201cBlocked on something\u201d scrolls away; tomorrow nobody remembers on what."),
        ("Discovered work takes the direct path \u2014 parent known, found mid-work \u2014 so it skips the claim pipeline; provenance is recorded on the event, and it can't be forgotten.",
         "The dependency stays a half-remembered aside; it never becomes real work."),
        ("Exactly one active node. The cursor moves; the old branch waits explicitly.",
         "Two threads \u201cin progress\u201d in your head; both decay."),
        ("Done requires evidence \u2014 the guard, not your optimism, closes the node.",
         "\u201cTokens are done, I think.\u201d"),
        ("Resume is derived: the blocker's subtree drained, so the cursor returns to colors. You didn't have to remember.",
         "Context-switch amnesia: \u201cwait, what was I doing?\u201d"),
        ("The interruption is a replayable event chain; states are derived by folding it, and the fold is authoritative.",
         "The interruption leaves no trace; the story is rebuilt from memory."),
    ],
    "s2": [
        ("A five-state machine where \u201cdone\u201d is earned, not typed.",
         "\u201cDone\u201d is a message you send."),
        ("The machine refuses \u2014 \u201cdone\u201d without evidence is not a state you can enter.",
         "\u201cDone\u201d is typed, believed, and billed."),
        ("The refusal is logged too \u2014 the attempt is visible, not silently swallowed.",
         "Nothing to see; nothing was ever at stake."),
        ("Done is a verdict backed by an artifact anyone can re-check. The gate also records the vapor attestation: none unfiled.",
         "Done is a claim backed by confidence."),
    ],
    "s7": [
        ("Cancel is a state, not an absence \u2014 the machine has a word for \u201cdecided against\u201d.",
         "Tasks die by neglect; nobody knows if they were done or dropped."),
        ("One active node at a time \u2014 starting is explicit.",
         "Everything is vaguely in progress."),
        ("Cancellation is a terminal verdict with a record \u2014 distinct from done and from forgetting.",
         "The task quietly leaves the list; done or abandoned? Unknowable."),
        ("Terminal means terminal \u2014 the machine enforces it, so dead work can't resurrect by accident.",
         "Three weeks later you restart it, duplicating the decision."),
        ("The parent isn't held hostage: drain counts done-or-cancelled.",
         "The dead task sits \u201cin progress\u201d forever, blocking its parent."),
    ],
    "s3": [
        ("Depth-first order is the traversal contract \u2014 no ad-hoc jumping.",
         "\u201cWhat should I do next?\u201d asked into the void."),
        ("Drain is computed from children's states \u2014 mechanical, not a judgment call.",
         "\u201cIs improve visual done? Let me scroll up\u2026\u201d"),
        ("The climb is arithmetic: children drained, so the parent drains.",
         "Manual bookkeeping, re-done every status update."),
        ("Exactly one answer to \u201cwhat now\u201d \u2014 derived by replaying the log.",
         "The most expensive question in knowledge work, answered by memory."),
    ],
    "s5": [
        ("Ideas are inventory \u2014 the system treats an unfiled idea as a tracked liability.",
         "This is where 90% of ideas live: a good sentence, then nothing."),
        ("Declaration is one event: who, when, what. The claim exists now \u2014 in the log, not in memory.",
         "\u201cDidn't we talk about pagination once?\u201d \u2014 yes, and it's gone."),
        ("The sweep drafts the file record on its own. Nobody drives; the pipeline moves.",
         "Someone has to remember to write it up. Nobody does."),
        ("Your job is judgment, not driving: one approval, and the draft becomes the record.",
         "The write-up happens never, or twice, differently."),
        ("Placement is proposed \u2014 parent and kind \u2014 by rule, not by recall.",
         "Where did we decide this belonged? Nowhere."),
        ("Second approval: the claim becomes a node with a place in traversal order.",
         "It resurfaces months later as a surprise, or never."),
        ("Replay derives the cursor: pagination. You approved twice; the system drove.",
         "The tree is whatever you remember to mention."),
    ],
    "s9": [
        ("Every claim starts the same way: declared, timestamped, in the log.",
         "Ideas start as sentences and end as rumors."),
        ("The claim is 0 days old and already visible \u2014 aging is automatic.",
         "Day 0 looks exactly like day 30: invisible."),
        ("The draft waits in the pipeline \u2014 in the log, not in anyone's head.",
         "The draft waits in a doc nobody opens."),
        ("Breach is derived, like drain: the predicate fires, the claim is flagged. Silence is not an option.",
         "Nobody is told it stalled. It just fades."),
        ("Late approval still works \u2014 the pipeline resumes where it waited.",
         "Three days later the context is gone; starting over costs more than the idea."),
    ],
    "s8": [
        ("Every completion ends with the same question, answered the same way.",
         "Completions end in a void; momentum leaks."),
        ("The suggestion is proactive \u2014 it arrives without being asked.",
         "You have to remember to ask what's next."),
        ("Receipts: trigger, rule version, rejected alternatives. Reproducible from the log. Claims awaiting approval appear beside node picks.",
         "\u201cYou should probably do X next\u201d \u2014 uncheckable advice from a black box."),
        ("Advisory, never autonomous: the machine suggests, you decide, the log records.",
         "Either nagging automation or no guidance at all."),
    ],
    "s6": [
        ("Reversals are designed for \u2014 the machine has a path back that isn't \u201cpretend it didn't happen\u201d.",
         "\u201cActually that's not done\u201d \u2014 and history quietly rewrites itself."),
        ("Even undo needs a reason \u2014 the guard applies symmetrically.",
         "Status flips with a sentence; the why evaporates."),
        ("The reversal is an event: done -> in_progress is in the log, with its reason.",
         "Was it ever done? Depends who you ask."),
        ("The second done supersedes with new evidence; both dones stand in the log.",
         "Which palette shipped? Unknowable after the edit."),
    ],
    "s4": [
        ("Finished means finished \u2014 a done branch is sealed, not a suggestion.",
         "\u201cWhile you're in there\u2026\u201d \u2014 scope grows without a decision."),
        ("New scope under a done branch is refused as a side effect \u2014 but the denial points somewhere: declare it as vapor and let the pipeline place it.",
         "It just appears in the plan; nobody decided it."),
        ("Scope change is a deliberate, reasoned event \u2014 reopened on the record.",
         "The re-opening happened in someone's head."),
        ("The new work carries provenance: added after re-open, with its reason attached.",
         "Nobody remembers when cache_metrics became part of fetch_metrics."),
    ],
}


# Legend shown on every chart screen. Swatches match the diagram colors exactly.
LEGEND = """
<div class="legend"><span class="lhead">Legend</span>
<span class="sw" style="background:#d1fae5;border-color:#059669"></span>done
<span class="sw" style="background:#fef3c7;border-color:#d97706"></span>in progress
<span class="sw dash" style="background:#fee2e2;border-color:#9ca3af"></span>blocked
<span class="sw" style="background:#f3f4f6;border-color:#9ca3af"></span>unstarted
<span class="sw it" style="background:#f3f4f6;border-color:#9ca3af"></span>cancelled
<span class="lsep">|</span>
<span class="sw ring" style="border-color:#c81e1e"></span>cursor: derived next
<span class="sw ring" style="border-color:#059669"></span>drained subtree
<span class="lsep">|</span>
<span class="sw" style="background:#f3f4f6;border-color:#9ca3af"></span>claim declared
<span class="sw" style="background:#fef3c7;border-color:#d97706"></span>pending your approval
<span class="sw" style="background:#dbeafe;border-color:#2563eb"></span>filed
<span class="sw" style="background:#d1fae5;border-color:#059669"></span>materialized
</div>"""


def parse_captions(path):
    text = open(path, encoding="utf-8").read()
    caps = []
    m = re.search(r"^caption: \{\s*\n(?:.*\n)*?\s*label: \"(.*)\"\n\}", text, re.M)
    if m:
        caps.append(m.group(1))
    for m in re.finditer(r"^\s*caption\.label: \"(.*)\"$", text, re.M):
        caps.append(m.group(1))
    return [html.escape(c).replace("\\n", "<br>") for c in caps]


def render_boards(sid, d2file):
    outdir = os.path.join(DEMO, f"_boards_{sid}")
    subprocess.run(["rm", "-rf", outdir], check=True)
    r = subprocess.run(
        ["d2", "--salt", sid, "--no-xml-tag", d2file, outdir],
        cwd=DEMO, capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"d2 failed for {d2file}:\n{r.stdout}\n{r.stderr}")
    files = sorted(glob.glob(os.path.join(outdir, "*")),
                   key=lambda p: (0 if os.path.basename(p) == "index" else 1, p))
    svgs = [open(f, encoding="utf-8").read() for f in files]
    subprocess.run(["rm", "-rf", outdir], check=True)
    return svgs


def story_html(sid, title):
    imagine, without, with_sys = STORIES[sid]
    return f"""
        <div class="story">
          <div class="kicker">{html.escape(title)}</div>
          <div class="beat"><span class="blabel">Imagine this</span><p>{imagine}</p></div>
          <div class="beat"><span class="blabel bad">Without the system</span><p>{without}</p></div>
          <div class="beat"><span class="blabel good">With the system</span><p>{with_sys}</p></div>
        </div>"""


def intro_html():
    paras = "".join(f"<p>{p}</p>" for p in INTRO["body"])
    return f"""
        <div class="story intro">
          <div class="kicker">{html.escape(INTRO['kicker'])}</div>
          <h2>{html.escape(INTRO['title'])}</h2>
          {paras}
        </div>"""


def main():
    collected = []
    for sid, d2file, title in SCENARIOS:
        svgs = render_boards(sid, d2file)
        captions = parse_captions(os.path.join(DEMO, d2file))
        content = CONTENT[sid]
        assert len(svgs) == len(captions) == len(content), \
            f"{sid}: boards={len(svgs)} captions={len(captions)} content={len(content)}"
        collected.append((sid, title, svgs, captions, content))

    steps_html = []
    nav_html = []
    flat = 0

    # Intro step
    steps_html.append(f"""
      <section class="step" id="step-0" data-scenario="Intro" data-board="story">
        {intro_html()}
      </section>""")
    flat = 1

    for sid, title, svgs, captions, content in collected:
        nav_html.append(
            f'<button class="navbtn" data-goto="{flat}">{html.escape(title)}</button>')
        # Story step
        steps_html.append(f"""
      <section class="step" id="step-{flat}" data-scenario="{html.escape(title)}" data-board="story">
        {story_html(sid, title)}
      </section>""")
        flat += 1
        # Chart steps
        for i, (svg, cap, (buys, chat)) in enumerate(zip(svgs, captions, content)):
            steps_html.append(f"""
      <section class="step" id="step-{flat}" data-scenario="{html.escape(title)}" data-board="{i}">
        <div class="diagram">{svg}</div>
        {LEGEND}
        <div class="side">
          <div class="event">{cap}</div>
          <div class="contrast">
            <div class="buys"><span class="tag">What the system buys</span><p>{buys}</p></div>
            <div class="chat"><span class="tag">Chat-only</span><p>{chat}</p></div>
          </div>
        </div>
      </section>""")
            flat += 1

    total = flat
    html_doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deterministic Tracking MVP — Demo Deck</title>
<style>
  :root {{ --green:#059669; --red:#c81e1e; --ink:#1f2937; --muted:#6b7280; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         color: var(--ink); margin: 0; background: #fafafa; }}
  header {{ position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e5e7eb;
           padding: 10px 20px; z-index: 10; }}
  header h1 {{ font-size: 17px; margin: 0 0 2px; }}
  header .hint {{ font-size: 13px; color: var(--muted); }}
  header .hint kbd {{ background:#f3f4f6; border:1px solid #d1d5db; border-radius:4px;
                     padding:1px 7px; font-family: inherit; font-size:12px; }}
  #progress {{ font-size: 13px; color: var(--muted); margin-top: 6px; }}
  #bar {{ height: 3px; background: #e5e7eb; margin-top: 6px; border-radius: 2px; }}
  #barfill {{ height: 100%; background: var(--green); border-radius: 2px; width: 0; }}
  nav.scenarios {{ display:flex; flex-wrap:wrap; gap:6px; padding:10px 20px; background:#fff;
                  border-bottom:1px solid #e5e7eb; }}
  .navbtn {{ font-size:12px; padding:5px 10px; border:1px solid #d1d5db; border-radius:20px;
            background:#fff; cursor:pointer; }}
  .navbtn:hover {{ background:#f3f4f6; }}
  main {{ max-width: 1280px; margin: 0 auto; padding: 18px 20px 80px; }}
  .step {{ display: none; }}
  .step.active {{ display: block; }}
  .diagram {{ background:#fff; border:1px solid #e5e7eb; border-radius:10px;
             padding:8px; margin-bottom:14px; }}
  .diagram svg {{ width:100%; height:auto; display:block; }}
  .legend {{ display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px;
            font-size:12px; color:var(--muted); background:#fff;
            border:1px solid #e5e7eb; border-radius:8px; padding:8px 12px;
            margin:-6px 0 14px; }}
  .legend .lhead {{ font-weight:700; text-transform:uppercase; font-size:10px;
                   letter-spacing:.06em; margin-right:4px; color:var(--ink); }}
  .legend .lsep {{ color:#d1d5db; margin:0 4px; }}
  .legend .sw {{ display:inline-block; width:14px; height:14px; border:2px solid;
               border-radius:3px; vertical-align:-2px; margin-right:2px; }}
  .legend .sw.dash {{ border-style:dashed; }}
  .legend .sw.it {{ font-style:italic; }}
  .legend .sw.ring {{ background:#fff; border-width:3px; }}
  .event {{ font-size:17px; font-weight:600; margin-bottom:12px; line-height:1.45; }}
  .contrast {{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; }}
  @media (max-width: 760px) {{ .contrast {{ grid-template-columns: 1fr; }} }}
  .buys, .chat {{ border-radius:10px; padding:12px 14px; }}
  .buys {{ background:#ecfdf5; border:1px solid #a7f3d0; }}
  .chat {{ background:#fef2f2; border:1px solid #fecaca; }}
  .tag {{ font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }}
  .buys .tag {{ color:var(--green); }}
  .chat .tag {{ color:var(--red); }}
  .buys p, .chat p {{ margin:6px 0 0; font-size:14.5px; line-height:1.5; }}
  .story {{ max-width: 720px; margin: 8vh auto 0; }}
  .story .kicker {{ font-size:12px; font-weight:700; text-transform:uppercase;
                   letter-spacing:.08em; color:var(--muted); margin-bottom:10px; }}
  .story h2 {{ font-size:34px; margin:0 0 18px; letter-spacing:-.01em; }}
  .story p {{ font-size:18px; line-height:1.65; margin:0 0 16px; }}
  .beat {{ margin-bottom:18px; }}
  .beat .blabel {{ font-size:11px; font-weight:700; text-transform:uppercase;
                  letter-spacing:.07em; color:var(--muted); }}
  .beat .blabel.bad {{ color:var(--red); }}
  .beat .blabel.good {{ color:var(--green); }}
  .beat p {{ margin:6px 0 0; }}
  .story.intro p:last-child {{ font-weight:600; }}
  .controls {{ position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
              display:flex; gap:10px; z-index:10; }}
  .controls button {{ font-size:15px; padding:10px 22px; border-radius:24px; border:1px solid #d1d5db;
                    background:#fff; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.08); }}
  .controls button:hover {{ background:#f3f4f6; }}
  .controls button:disabled {{ opacity:.35; cursor:default; }}
</style>
</head>
<body>
<header>
  <h1>Deterministic Tracking MVP &mdash; demo deck</h1>
  <div class="hint"><kbd>n</kbd> next step &nbsp;&middot;&nbsp; <kbd>b</kbd> back &nbsp;&middot;&nbsp; or use the buttons below</div>
  <div id="progress"></div>
  <div id="bar"><div id="barfill"></div></div>
</header>
<nav class="scenarios">{"".join(nav_html)}</nav>
<main>
{"".join(steps_html)}
</main>
<div class="controls">
  <button id="backBtn">&larr; Back (b)</button>
  <button id="nextBtn">Next (n) &rarr;</button>
</div>
<script>
(function() {{
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  var total = steps.length;
  var idx = 0;
  var progress = document.getElementById('progress');
  var barfill = document.getElementById('barfill');
  var backBtn = document.getElementById('backBtn');
  var nextBtn = document.getElementById('nextBtn');

  function show(i) {{
    idx = Math.max(0, Math.min(total - 1, i));
    steps.forEach(function(s, j) {{ s.classList.toggle('active', j === idx); }});
    var sc = steps[idx].getAttribute('data-scenario');
    var bd = steps[idx].getAttribute('data-board');
    var where = bd === 'story' ? 'story' : 'board ' + bd;
    progress.textContent = 'Step ' + (idx + 1) + ' of ' + total + '  ·  ' + sc + '  ·  ' + where;
    barfill.style.width = ((idx + 1) / total * 100) + '%';
    backBtn.disabled = idx === 0;
    nextBtn.disabled = idx === total - 1;
    window.scrollTo({{top: 0, behavior: 'smooth'}});
  }}
  function next() {{ show(idx + 1); }}
  function back() {{ show(idx - 1); }}
  nextBtn.addEventListener('click', next);
  backBtn.addEventListener('click', back);
  document.querySelectorAll('.navbtn').forEach(function(b) {{
    b.addEventListener('click', function() {{ show(parseInt(b.getAttribute('data-goto'), 10)); }});
  }});
  document.addEventListener('keydown', function(e) {{
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'n') {{ e.preventDefault(); next(); }}
    else if (k === 'b') {{ e.preventDefault(); back(); }}
  }});
  show(0);
}})();
</script>
</body>
</html>
"""
    out = os.path.join(DEMO, "index.html")
    open(out, "w", encoding="utf-8").write(html_doc)
    print(f"wrote {out} ({os.path.getsize(out)//1024} KB, {total} steps)")


if __name__ == "__main__":
    main()
