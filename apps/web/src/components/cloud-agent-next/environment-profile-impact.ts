type ProfileSetup = {
  id: string;
  name: string;
  commands: readonly unknown[];
  vars: readonly { key: string }[];
};

/** Input follows the session resolver's base-to-top profile order. Never return values. */
export function describeEnvironmentProfileImpact(
  profiles: readonly ProfileSetup[],
  environmentKeys: readonly string[]
) {
  const commandProfiles = profiles
    .filter(profile => profile.commands.length > 0)
    .map(profile => profile.name);
  const overrides = new Map<string, string>();
  const keys = new Set(environmentKeys);
  for (const profile of profiles) {
    for (const variable of profile.vars) {
      if (keys.has(variable.key)) overrides.set(variable.key, profile.name);
    }
  }
  return {
    commandProfiles,
    overrides: [...overrides].map(([key, profileName]) => ({ key, profileName })),
  };
}
