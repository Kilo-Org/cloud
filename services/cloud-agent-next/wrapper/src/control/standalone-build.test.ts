import { expect, it } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

it('builds the control entrypoint with only standalone wrapper runtime dependencies', async () => {
  const wrapper = resolve(import.meta.dir, '../..');
  const fixture = await mkdtemp(join(tmpdir(), 'standalone-control-build-'));
  try {
    const isolatedWrapper = join(fixture, 'wrapper');
    await mkdir(isolatedWrapper);
    await Promise.all([
      cp(join(wrapper, 'src'), join(isolatedWrapper, 'src'), { recursive: true }),
      cp(join(wrapper, 'package.json'), join(isolatedWrapper, 'package.json')),
      cp(join(wrapper, '../src/shared'), join(fixture, 'src/shared'), { recursive: true }),
    ]);
    const manifest = (await Bun.file(join(isolatedWrapper, 'package.json')).json()) as {
      dependencies: Record<string, string>;
    };
    const nodeModules = join(isolatedWrapper, 'node_modules');
    for (const dependency of Object.keys(manifest.dependencies)) {
      const target = join(nodeModules, dependency);
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(wrapper, 'node_modules', dependency), target, 'dir');
    }
    await symlink(nodeModules, join(fixture, 'node_modules'), 'dir');
    expect(() =>
      Bun.resolveSync(
        '@kilocode/worker-utils/cloud-agent-worktree-changes',
        join(fixture, 'src/shared')
      )
    ).toThrow();

    const result = await Bun.build({
      entrypoints: [join(isolatedWrapper, 'src/control/main.ts')],
      root: fixture,
      target: 'bun',
      minify: true,
    });
    expect(result.logs.filter(log => log.level === 'error').map(log => log.message)).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    const output = result.outputs[0];
    if (!output) throw new Error('Missing control wrapper bundle');
    expect(output.size).toBeGreaterThan(0);
    expect(await output.text()).not.toContain('@kilocode/worker-utils');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
