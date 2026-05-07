/** Skills tab for the profile editor. */
'use client';

import { useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { unzipSync, strFromU8 } from 'fflate';
import { Loader2, Plus, Sparkles, Upload, FileText, X, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { useProfileMutations, type ProfileSkill } from '@/hooks/useCloudAgentProfiles';
import { cn } from '@/lib/utils';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_FILE_PATH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

// Keep in sync with apps/web/src/lib/agent/profile-skills-service.ts limits.
const MAX_SKILL_MARKDOWN_LENGTH = 100_000;
const MAX_COMPANION_FILES = 20;
const MAX_COMPANION_FILE_SIZE = 100_000;
const MAX_COMPANION_FILES_TOTAL = 500_000;
const MAX_PATH_LENGTH = 200;

type Props = {
  profileId: string;
  organizationId: string | undefined;
  skills: ProfileSkill[];
};

export function SkillsTab({ profileId, organizationId, skills }: Props) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [importing, setImporting] = useState(false);
  const { createCustomSkill } = useProfileMutations({ organizationId });
  const isDragging = dragDepth > 0;

  const dragHasZip = (event: DragEvent<HTMLDivElement>) =>
    Array.from(event.dataTransfer?.items ?? []).some(item => item.kind === 'file');

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragDepth(0);
    const dropped = Array.from(event.dataTransfer.files).filter(f =>
      f.name.toLowerCase().endsWith('.zip')
    );
    if (dropped.length === 0) {
      toast.error('Drop a .zip of a skill folder');
      return;
    }

    setImporting(true);
    const existingNames = new Set(skills.map(s => s.name));
    let succeeded = 0;
    try {
      for (const file of dropped) {
        try {
          const extracted = await extractSkillZip(file);
          const baseSlug =
            slugifySkillName(extracted.frontmatterName) ||
            slugifySkillName(file.name.replace(/\.zip$/i, '')) ||
            'skill';
          const name = uniqueSkillName(baseSlug, existingNames);
          existingNames.add(name);
          await createCustomSkill.mutateAsync({
            profileId,
            organizationId,
            name,
            description: extracted.frontmatterDescription,
            rawMarkdown: extracted.rawMarkdown,
            files: extracted.fileCount > 0 ? extracted.files : undefined,
          });
          toast.success(`Skill "${name}" added`);
          succeeded += 1;
        } catch (error) {
          toast.error(
            `${file.name}: ${error instanceof Error ? error.message : 'failed to import'}`
          );
        }
      }
    } finally {
      setImporting(false);
    }
    if (succeeded > 0 && isAdding) setIsAdding(false);
  };

  return (
    <div
      className={cn(
        'relative flex min-h-full flex-col gap-2 p-4 transition-colors',
        isDragging && 'border-primary bg-primary/5 border-2 border-dashed'
      )}
      onDragEnter={event => {
        if (!dragHasZip(event)) return;
        event.preventDefault();
        setDragDepth(d => d + 1);
      }}
      onDragLeave={() => setDragDepth(d => Math.max(0, d - 1))}
      onDragOver={event => {
        if (!dragHasZip(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={handleDrop}
    >
      {skills.map(skill =>
        editingId === skill.id ? (
          <SkillForm
            key={skill.id}
            mode="edit"
            initial={skill}
            profileId={profileId}
            organizationId={organizationId}
            onDone={() => setEditingId(null)}
          />
        ) : (
          <SkillRow
            key={skill.id}
            skill={skill}
            profileId={profileId}
            organizationId={organizationId}
            onEdit={() => {
              setEditingId(skill.id);
              setIsAdding(false);
            }}
          />
        )
      )}

      {isAdding ? (
        <SkillForm
          mode="create"
          profileId={profileId}
          organizationId={organizationId}
          onDone={() => setIsAdding(false)}
        />
      ) : (
        <Button
          variant="outline"
          className="h-11 w-full border-dashed"
          onClick={() => {
            setIsAdding(true);
            setEditingId(null);
          }}
          disabled={importing}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add skill manually (or drop a .zip)
        </Button>
      )}

      {skills.length === 0 && !isAdding && !importing && (
        <p className="text-muted-foreground py-2 text-center text-sm">
          No skills yet. Drop a skill folder .zip here to add one.
        </p>
      )}

      {/* Spacer makes the rest of the tab a drop target too. */}
      <div className="flex-1" />

      {(isDragging || importing) && (
        <div className="bg-background/80 pointer-events-none absolute inset-0 flex items-center justify-center rounded-md backdrop-blur-sm">
          <div className="text-foreground flex items-center gap-2 text-sm font-medium">
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Importing skill…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                Drop .zip to add as a new skill
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function slugifySkillName(value: string | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function uniqueSkillName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function SkillRow({
  skill,
  profileId,
  organizationId,
  onEdit,
}: {
  skill: ProfileSkill;
  profileId: string;
  organizationId: string | undefined;
  onEdit: () => void;
}) {
  const { deleteSkill } = useProfileMutations({ organizationId });
  const [deleting, setDeleting] = useState(false);

  const fileCount = Object.keys(skill.files ?? {}).length;
  const companionBytes = Object.values(skill.files ?? {}).reduce((sum, c) => sum + c.length, 0);
  const totalBytes = skill.rawMarkdown.length + companionBytes;
  const sizeKb = (totalBytes / 1024).toFixed(1);

  return (
    <div className="hover:bg-accent/50 rounded-lg border p-3 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Sparkles className="text-muted-foreground h-4 w-4" />
            <code className="bg-muted rounded px-2 py-0.5 font-mono text-sm">{skill.name}</code>
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              {skill.sourceType}
            </span>
            <span className="text-muted-foreground text-xs">{sizeKb} KB</span>
            {fileCount > 0 && (
              <span className="text-muted-foreground text-xs">
                +{fileCount} file{fileCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {skill.description && (
            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{skill.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={onEdit}
            disabled={deleting}
            aria-label="Edit skill"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <InlineDeleteConfirmation
            onDelete={async () => {
              setDeleting(true);
              try {
                await deleteSkill.mutateAsync({
                  profileId,
                  organizationId,
                  skillId: skill.id,
                });
                toast.success(`Skill "${skill.name}" deleted`);
              } catch (error) {
                console.error('Failed to delete skill:', error);
                toast.error('Failed to delete skill');
              } finally {
                setDeleting(false);
              }
            }}
            isLoading={deleting}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Parse frontmatter `name` and `description` out of a SKILL.md body.
 * Matches the minimal extension parser (only these two fields).
 */
function parseSkillFrontmatter(rawMarkdown: string): { name?: string; description?: string } {
  const match = rawMarkdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!match) return {};
  const strip = (v: string) => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  const nameMatch = match[1].match(/^name\s*:\s*(.+)$/m);
  const descMatch = match[1].match(/^description\s*:\s*(.+)$/m);
  return {
    name: nameMatch ? strip(nameMatch[1]) : undefined,
    description: descMatch ? strip(descMatch[1]) : undefined,
  };
}

type ExtractedSkill = {
  rawMarkdown: string;
  files: Record<string, string>;
  fileCount: number;
  totalBytes: number;
  frontmatterName?: string;
  frontmatterDescription?: string;
};

/**
 * Returns true for OS-generated metadata that shouldn't count as skill content:
 * macOS `__MACOSX/...` and `._*` AppleDouble files, Finder `.DS_Store`,
 * Windows `Thumbs.db` and `desktop.ini`. Matches at any depth.
 */
function isJunkEntry(path: string): boolean {
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base.startsWith('._')) return true;
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini';
}

/**
 * Extract a skill bundle from a zip. Looks for `SKILL.md` at the root; if the
 * archive uses a single top-level directory, strips it (matches the extension
 * marketplace's `tar --strip-components=1` behavior).
 *
 * Throws an Error with a user-facing message on invalid archives.
 */
async function extractSkillZip(file: File): Promise<ExtractedSkill> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    throw new Error('Expected a .zip file');
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength > 5 * 1024 * 1024) {
    throw new Error('Zip file is larger than 5 MB');
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf, {
      filter(entry) {
        return entry.size <= MAX_COMPANION_FILE_SIZE * 2; // trust but verify below
      },
    });
  } catch (error) {
    throw new Error(`Unable to read zip: ${error instanceof Error ? error.message : 'unknown'}`);
  }

  // Drop directory entries (keys ending with '/') and OS-generated junk
  // (Finder's __MACOSX/ + ._* AppleDouble files, Windows Thumbs.db / desktop.ini)
  // so a folder zipped via Finder still has a single detectable top-level dir.
  const filePaths = Object.keys(entries).filter(k => !k.endsWith('/') && !isJunkEntry(k));
  if (filePaths.length === 0) {
    throw new Error('Zip is empty');
  }
  // Detect a single top-level directory to strip. Allow a stray root file
  // (e.g. a README sibling) to still trigger stripping when all *other* paths
  // share one top dir.
  const rootDirs = new Set<string>();
  for (const p of filePaths) {
    const slash = p.indexOf('/');
    if (slash > 0) rootDirs.add(p.slice(0, slash));
  }
  const stripPrefix =
    rootDirs.size === 1 && filePaths.every(p => p.startsWith(`${[...rootDirs][0]}/`))
      ? `${[...rootDirs][0]}/`
      : '';

  let skillMd: string | null = null;
  const files: Record<string, string> = {};
  let totalBytes = 0;
  let fileCount = 0;

  for (const path of filePaths) {
    const rel = stripPrefix && path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) : path;
    if (!rel || rel === '') continue;

    if (rel.includes('..') || rel.startsWith('/') || rel.length > MAX_PATH_LENGTH) {
      throw new Error(`Rejected file path "${rel}"`);
    }
    if (rel.toLowerCase() === 'skill.md') {
      const content = strFromU8(entries[path]);
      if (content.length > MAX_SKILL_MARKDOWN_LENGTH) {
        throw new Error(`SKILL.md exceeds ${MAX_SKILL_MARKDOWN_LENGTH} bytes`);
      }
      skillMd = content;
      continue;
    }
    if (!SKILL_FILE_PATH_PATTERN.test(rel)) {
      throw new Error(`File "${rel}" contains disallowed characters`);
    }

    const content = strFromU8(entries[path]);
    if (content.length > MAX_COMPANION_FILE_SIZE) {
      throw new Error(`File "${rel}" exceeds ${MAX_COMPANION_FILE_SIZE} bytes`);
    }
    fileCount += 1;
    totalBytes += content.length;
    if (fileCount > MAX_COMPANION_FILES) {
      throw new Error(`Skill may have at most ${MAX_COMPANION_FILES} companion files`);
    }
    if (totalBytes > MAX_COMPANION_FILES_TOTAL) {
      throw new Error(`Companion files exceed ${MAX_COMPANION_FILES_TOTAL} bytes total`);
    }
    files[rel] = content;
  }

  if (!skillMd) {
    throw new Error('Zip must contain SKILL.md at the root');
  }

  const frontmatter = parseSkillFrontmatter(skillMd);
  return {
    rawMarkdown: skillMd,
    files,
    fileCount,
    totalBytes,
    frontmatterName: frontmatter.name,
    frontmatterDescription: frontmatter.description,
  };
}

// -------------------------------------------------------------------
// SkillForm — shared create/edit form
// -------------------------------------------------------------------

type SkillFormProps = {
  profileId: string;
  organizationId: string | undefined;
  onDone: () => void;
} & ({ mode: 'create'; initial?: undefined } | { mode: 'edit'; initial: ProfileSkill });

/**
 * Template shown in the editor when adding a new skill by hand.
 * Matches Anthropic's SKILL.md format: YAML frontmatter with `name` + `description`,
 * followed by the skill body.
 */
const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: Describe when the agent should load this skill. Be specific — this is what the model reads to decide whether to use it (e.g. "Use when the user asks about X, Y, or Z.").
---

# My Skill

Instructions the agent should follow when this skill is active.

## When to use

Explain in more detail when this skill applies.

## Steps

1. First step
2. Second step
`;

/**
 * Rebuild a SKILL.md so its frontmatter matches `name` / `description`. Any
 * existing `---` block at the top is replaced; only `name` and `description`
 * keys are kept (the schema doesn't use others). If there's no frontmatter,
 * one is prepended.
 */
function writeFrontmatter(
  rawMarkdown: string,
  name: string,
  description: string | null | undefined
): string {
  const match = rawMarkdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const body = match ? rawMarkdown.slice(match[0].length) : rawMarkdown.replace(/^\s+/, '');
  const descLine = description ? `\ndescription: ${description}` : '';
  return `---\nname: ${name}${descLine}\n---\n\n${body}`;
}

/**
 * Initial textarea content. For new skills, a template; for existing skills,
 * the stored markdown with its frontmatter normalized to match the DB row so
 * the user always sees the `name` / `description` that will be used.
 */
function initialSkillMarkdown(props: SkillFormProps): string {
  if (props.mode === 'create') return NEW_SKILL_TEMPLATE;
  const { name, description, rawMarkdown } = props.initial;
  const parsed = parseSkillFrontmatter(rawMarkdown);
  const frontmatterMatches =
    parsed.name === name && (parsed.description ?? null) === (description ?? null);
  return frontmatterMatches ? rawMarkdown : writeFrontmatter(rawMarkdown, name, description);
}

function SkillForm(props: SkillFormProps) {
  const { profileId, organizationId, onDone, mode } = props;
  const { createCustomSkill, updateSkill } = useProfileMutations({ organizationId });
  const [rawMarkdown, setRawMarkdown] = useState(() => initialSkillMarkdown(props));
  const [files, setFiles] = useState<Record<string, string>>(
    mode === 'edit' ? { ...props.initial.files } : {}
  );
  const [saving, setSaving] = useState(false);

  const fileCount = Object.keys(files).length;
  const companionBytes = Object.values(files).reduce((sum, c) => sum + c.length, 0);

  const parsed = parseSkillFrontmatter(rawMarkdown);
  const parsedNameValid = !!parsed.name && SKILL_NAME_PATTERN.test(parsed.name);

  const handleSave = async () => {
    if (!rawMarkdown.trim()) {
      toast.error('Skill content is required');
      return;
    }
    const { name: parsedName, description: parsedDescription } = parseSkillFrontmatter(rawMarkdown);
    if (!parsedName) {
      toast.error('Add a `name:` line to the frontmatter at the top of SKILL.md');
      return;
    }
    if (!SKILL_NAME_PATTERN.test(parsedName)) {
      toast.error(
        'Frontmatter `name` must be lowercase letters, digits, and dashes, starting with a letter or digit'
      );
      return;
    }
    const description = parsedDescription?.trim() || undefined;

    setSaving(true);
    try {
      if (mode === 'edit') {
        await updateSkill.mutateAsync({
          profileId,
          organizationId,
          skillId: props.initial.id,
          name: parsedName,
          description: description ?? null,
          rawMarkdown,
          files,
        });
        toast.success(`Skill "${parsedName}" updated`);
      } else {
        await createCustomSkill.mutateAsync({
          profileId,
          organizationId,
          name: parsedName,
          description,
          rawMarkdown,
          files: fileCount > 0 ? files : undefined,
        });
        toast.success(`Skill "${parsedName}" added`);
      }
      onDone();
    } catch (error) {
      console.error('Failed to save skill:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      {mode === 'edit' && (
        <div className="text-muted-foreground text-xs uppercase tracking-wide">Editing skill</div>
      )}

      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="skill-markdown">SKILL.md</Label>
          <span className="font-mono text-xs">
            <span className="text-muted-foreground">slug: </span>
            <code
              className={cn(
                'rounded px-1.5 py-0.5',
                parsed.name
                  ? parsedNameValid
                    ? 'bg-muted'
                    : 'bg-destructive/10 text-destructive'
                  : 'bg-destructive/10 text-destructive'
              )}
            >
              {parsed.name ?? 'missing'}
            </code>
          </span>
        </div>
        <Textarea
          id="skill-markdown"
          value={rawMarkdown}
          onChange={e => setRawMarkdown(e.target.value)}
          rows={14}
          className="font-mono text-xs"
          autoFocus={mode === 'create'}
          disabled={saving}
        />
        <span className="text-muted-foreground text-xs">
          SKILL.md: {(rawMarkdown.length / 1024).toFixed(1)} KB · max 100 KB
          {fileCount > 0 && (
            <>
              {' · '}
              {fileCount} companion file{fileCount === 1 ? '' : 's'} (
              {(companionBytes / 1024).toFixed(1)} KB)
            </>
          )}
        </span>
      </div>

      {fileCount > 0 && (
        <div className="space-y-1 rounded-md border p-2">
          <div className="text-muted-foreground text-xs font-medium">Companion files</div>
          {Object.entries(files).map(([path, content]) => (
            <div
              key={path}
              className="bg-muted/30 flex items-center gap-2 rounded px-2 py-1 font-mono text-xs"
            >
              <FileText className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{path}</span>
              <span className="text-muted-foreground">{(content.length / 1024).toFixed(1)} KB</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground cursor-pointer"
                onClick={() => {
                  const next = { ...files };
                  delete next[path];
                  setFiles(next);
                }}
                aria-label={`Remove ${path}`}
                disabled={saving}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === 'edit' ? (
            'Save changes'
          ) : (
            'Add skill'
          )}
        </Button>
      </div>
    </div>
  );
}
