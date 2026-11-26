/**
 * /skills: downloadable agent skills. The files are embedded by scripts/build-skill.ts (skill-bundle.ts);
 * this module serves them and renders the page that explains how to install them.
 */
import { esc, pageEnd, pageStart, type SiteInfo } from "./landing.js";
import { SKILLS } from "./skill-bundle.js";

const CSS = `
.skills-hero{padding-top:44px;padding-bottom:8px}
.skills-hero h1{font-size:clamp(28px,4vw,40px);max-width:26ch}
.skill{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:start}
.skill h3{margin:0 0 6px;font-size:20px}
.skill p{margin:0 0 10px;color:var(--muted)}
.skill .dl{display:inline-block;font:600 15px ui-sans-serif,system-ui,sans-serif;background:var(--accent);color:#fff;padding:11px 18px;border-radius:10px;text-decoration:none;white-space:nowrap}
@media (prefers-color-scheme:dark){.skill .dl{color:#0b1020}}
.files{columns:2;font-size:14px;margin:8px 0 0;padding-left:18px;color:var(--muted)}
@media (max-width:820px){.skill{grid-template-columns:1fr}.files{columns:1}}
`;

const TYPES: Record<string, string> = { md: "text/markdown; charset=utf-8", mjs: "text/javascript; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8" };

export function skillIndex(base: string) {
  return {
    skills: Object.entries(SKILLS).map(([name, s]) => ({
      name,
      description: s.description,
      zip: `${base}/skills/${name}.zip`,
      skill_md: `${base}/skills/${name}/SKILL.md`,
      files: Object.keys(s.files).map((f) => `${base}/skills/${name}/${f}`),
    })),
  };
}

/** A file of a skill, or the zip, by URL path under /skills. */
export function skillAsset(path: string): { body: string | Uint8Array; type: string; disposition?: string } | undefined {
  const zip = /^([a-z0-9-]+)\.zip$/.exec(path);
  if (zip && Object.hasOwn(SKILLS, zip[1]!)) {
    const bytes = Uint8Array.from(atob(SKILLS[zip[1]!]!.zip), (c) => c.charCodeAt(0));
    return { body: bytes, type: "application/zip", disposition: `attachment; filename="${zip[1]}.zip"` };
  }
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(path);
  if (!m || !Object.hasOwn(SKILLS, m[1]!)) return undefined;
  const files = SKILLS[m[1]!]!.files;
  if (!Object.hasOwn(files, m[2]!)) return undefined; // exact lookup only: no path tricks reach the filesystem
  return { body: files[m[2]!]!, type: TYPES[m[2]!.split(".").pop()!] ?? "text/plain; charset=utf-8" };
}

export function skillsPage(info: SiteInfo): string {
  const base = esc(info.baseUrl);
  const cards = Object.entries(SKILLS)
    .map(
      ([name, s]) => `<div class="card skill"><div>
        <h3><code>${esc(name)}</code></h3>
        <p>${esc(s.description)}</p>
        <ul class="files">${Object.keys(s.files).map((f) => `<li><a href="/skills/${esc(name)}/${esc(f)}">${esc(f)}</a></li>`).join("")}</ul>
      </div><a class="dl" href="/skills/${esc(name)}.zip" download>Download .zip</a></div>`,
    )
    .join("");
  const first = Object.keys(SKILLS)[0] ?? "archibase-plan-converter";

  const body = `
<div class="wrap skills-hero">
  <div class="eyebrow">Agent skills</div>
  <h1>Teach any agent to convert floor plans into the Archibase format.</h1>
  <p class="lede">A skill is a folder of instructions and tools that an agent loads when it needs them. This one turns a scan, drawing or description into a metric room graph plus geometry, and checks it against the same rules the corpus enforces. Free, MIT licensed, no dependencies beyond Node.</p>
</div>
<section style="border-top:0;padding-top:20px"><div class="wrap">
  ${cards}
</div></section>
<section><div class="wrap">
  <h2>Install</h2>
  <p class="sub">Any agent that can read files and run Node can use it. It works the same everywhere: the agent reads <code>SKILL.md</code>, traces the plan, and runs one script.</p>
  <div class="card"><h3 style="margin:0 0 6px">Claude Code</h3>
<pre><code>mkdir -p ~/.claude/skills &amp;&amp; cd ~/.claude/skills
curl -LO ${base}/skills/${esc(first)}.zip &amp;&amp; unzip ${esc(first)}.zip</code></pre>
  <p class="sub" style="margin:0">Use <code>.claude/skills/</code> inside a project to share it with a team. Then ask Claude to convert a floor plan.</p></div>
  <div class="card" style="margin-top:14px"><h3 style="margin:0 0 6px">Claude apps and other skill-aware agents</h3>
  <p class="sub" style="margin:0">Upload the zip in your app's skills settings. The folder inside is already named correctly.</p></div>
  <div class="card" style="margin-top:14px"><h3 style="margin:0 0 6px">Any other agent (Cursor, Codex, your own)</h3>
  <p class="sub" style="margin:0">Unzip it into your project and tell the agent: <em>"Follow ${esc(first)}/SKILL.md to convert this plan."</em> Agents can also read everything directly: <a href="/skills/index.json">/skills/index.json</a> lists every file.</p></div>
</div></section>
<section><div class="wrap">
  <h2>How it works</h2>
  <ul class="notes">
    <li><b>The agent does the looking.</b> It reads the drawing, fixes the scale, and writes room outlines, doors and windows in metres.</li>
    <li><b>The script does the careful part.</b> Areas, which rooms connect, window counts, bedroom and bathroom totals, licence rules.</li>
    <li><b>Mistakes are caught.</b> Overlapping rooms, a wrong scale, a door between nothing, or a licence that can't be sold are errors, not silent bad data.</li>
    <li><b>Checked against real data.</b> Fed the shapes of real plans from the corpus, it reproduces their door links and window counts.</li>
  </ul>
  <p class="sub" style="margin-top:18px">Converted a plan with clear rights (public domain, CC0, CC BY, or your own)? ${info.contactEmail ? `Send it to <a href="mailto:${esc(info.contactEmail)}">${esc(info.contactEmail)}</a>` : "Contact the project maintainers"} and we'll consider adding it to the corpus.</p>
</div></section>`;

  return (
    pageStart(info, {
      title: "Archibase agent skills: convert floor plans into the corpus format",
      description: "A free, downloadable agent skill that converts floor plans into Archibase's metric room-graph format and validates the result.",
      path: "/skills",
      css: CSS,
    }) +
    `<main>${body}</main>` +
    pageEnd(info)
  );
}
