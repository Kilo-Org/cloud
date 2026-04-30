type CurrentUser = {
  id: string;
};

export function currentUserIdFromUser(user: CurrentUser | null | undefined): string | null {
  return user?.id ?? null;
}
