import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/unstable/process";
import { spawnAndCollect } from "../providerSnapshot.ts";
import { readAmpSettingsFile } from "../AmpSettingsFile.ts";
import type { AmpSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

const Frontmatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  "user-invocable": Schema.optional(Schema.Boolean),
});
const NativeSkills = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      baseDir: Schema.String,
      source: Schema.String,
    }),
  ),
});
const decodeNativeSkills = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeSkills));
const decodeFrontmatter = Schema.decodeUnknownEffect(Frontmatter);

export const discoverAmpSkills = Effect.fn("discoverAmpSkills")(function* (
  settings: AmpSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const command = settings.binaryPath || "amp";
  const native = yield* Effect.gen(function* () {
    const run = Effect.fn("AmpSkills.run")(function* (args: ReadonlyArray<string>) {
      const resolved = yield* resolveSpawnCommand(
        command,
        [
          ...args,
          "--no-color",
          ...(settings.settingsFile ? ["--settings-file", settings.settingsFile] : []),
        ],
        { env: environment },
      );
      return yield* spawnAndCollect(
        command,
        ChildProcess.make(resolved.command, resolved.args, {
          cwd,
          env: { ...environment, AMP_SKIP_UPDATE_CHECK: "1" },
          shell: resolved.shell,
          stdin: "ignore",
        }),
      );
    });
    const auth = yield* run(["usage"]);
    if (auth.code !== 0) return undefined;
    const result = yield* run(["skill", "list", "--json"]);
    if (result.code !== 0) return undefined;
    const catalog = yield* decodeNativeSkills(result.stdout);
    return yield* Effect.forEach(catalog.skills, (skill) =>
      Effect.try(
        () =>
          ({
            name: skill.name.trim(),
            path: skill.baseDir.startsWith("file:")
              ? NodeURL.fileURLToPath(new URL("SKILL.md", `${skill.baseDir.replace(/\/$/, "")}/`))
              : `${skill.baseDir}/${skill.name}`,
            scope: skill.source,
            enabled: true,
            ...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
          }) satisfies ServerProviderSkill,
      ),
    );
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.timeoutOption(15_000),
  );
  if (Option.isSome(native) && native.value !== undefined) return native.value;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const config = yield* readAmpSettingsFile(settings, environment);
  const configHome = environment.XDG_CONFIG_HOME || path.join(home, ".config");
  const roots: Array<{ directory: string; scope: string }> = [
    { directory: path.join(configHome, "agents", "skills"), scope: "user" },
    { directory: path.join(home, ".agents", "skills"), scope: "user" },
    { directory: path.join(configHome, "amp", "skills"), scope: "user" },
  ];
  let directory = path.resolve(cwd);
  while (true) {
    roots.push({ directory: path.join(directory, ".agents", "skills"), scope: "project" });
    if (!config["amp.skills.disableClaudeCodeSkills"])
      roots.push({ directory: path.join(directory, ".claude", "skills"), scope: "project" });
    if (directory === home || (yield* fs.exists(path.join(directory, ".git")))) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!config["amp.skills.disableClaudeCodeSkills"])
    roots.push({ directory: path.join(home, ".claude", "skills"), scope: "user" });
  if (!config["amp.skills.disableClaudeCodeSkills"])
    roots.push({ directory: path.join(home, ".claude", "plugins", "cache"), scope: "plugin" });
  for (const entry of (config["amp.skills.path"] ?? "").split(path.sep === "\\" ? ";" : ":")) {
    if (entry.trim())
      roots.push({
        directory: path.resolve(cwd, entry.replace(/^~(?=[/\\]|$)/, home)),
        scope: "custom",
      });
  }
  const skills = new Map<string, ServerProviderSkill>();
  const visited = new Set<string>();
  let remainingEntries = 10_000;
  let remainingBytes = 8_000_000;
  const visit = Effect.fn("AmpSkills.visit")(function* (
    root: { directory: string; scope: string },
    depth: number,
  ): Effect.fn.Return<void, never> {
    if (depth > 8 || remainingEntries <= 0 || remainingBytes <= 0) return;
    const real = yield* fs.realPath(root.directory).pipe(Effect.orElseSucceed(() => undefined));
    if (!real || visited.has(real)) return;
    visited.add(real);
    const entries = yield* fs
      .readDirectory(real)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    remainingEntries -= entries.length;
    if (remainingEntries < 0) return;
    if (entries.includes("SKILL.md")) {
      const skillPath = path.join(root.directory, "SKILL.md");
      const size = yield* fs.stat(skillPath).pipe(
        Effect.map((stat) => Number(stat.size)),
        Effect.orElseSucceed(() => Infinity),
      );
      if (size > Math.min(1_000_000, remainingBytes)) return;
      remainingBytes -= size;
      const contents = yield* fs.readFileString(skillPath).pipe(Effect.orElseSucceed(() => ""));
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1];
      if (!frontmatter) return;
      const parsed = yield* Effect.try(() => parseYaml(frontmatter)).pipe(
        Effect.flatMap(decodeFrontmatter),
        Effect.orElseSucceed(() => undefined),
      );
      const name = parsed?.name?.trim() || path.basename(root.directory);
      if (!parsed || !name || skills.has(name)) return;
      const description = parsed.description?.trim();
      skills.set(name, {
        name,
        path: skillPath,
        scope: root.scope,
        enabled: parsed["user-invocable"] !== false,
        ...(description ? { description } : {}),
      });
      return;
    }
    for (const entry of entries.toSorted()) {
      if (!entry.startsWith("."))
        yield* visit({ ...root, directory: path.join(root.directory, entry) }, depth + 1);
    }
  });
  for (const root of roots) yield* visit(root, 0);
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
});

const SKILL_MENTION = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export function rewriteAmpSkillMentions(
  text: string,
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "enabled">>,
): string {
  const names = new Set(skills.filter((skill) => skill.enabled).map((skill) => skill.name));
  const requested = new Set<string>();
  const prompt = text.replace(SKILL_MENTION, (match, prefix: string, name: string) => {
    if (!names.has(name)) return match;
    requested.add(name);
    return `${prefix}${name}`;
  });
  return requested.size === 0
    ? text
    : `${prompt}\n\nLoad these skills with the skill tool before starting: ${[...requested].join(", ")}.`;
}
