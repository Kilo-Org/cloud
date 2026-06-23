const MAX_SLUG_ATTEMPTS = 3;

type FriendlySlugDependencies = {
  generate(): string;
  isStored(slug: string): Promise<boolean>;
  map(slug: string): Promise<boolean>;
};

export async function allocateFriendlySlug(
  dependencies: FriendlySlugDependencies
): Promise<string> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = dependencies.generate();
    if (await dependencies.isStored(slug)) {
      continue;
    }
    if (await dependencies.map(slug)) {
      return slug;
    }
  }

  throw new Error('Unable to allocate an available deployment URL');
}
