/**
 * The id of the key the key screens just created.
 *
 * The import and generate screens are routes, so the host editor they were
 * opened from is below them in the stack; this slot is how the screen hands its
 * result back to the editor that must now select it. One key is created per
 * visit, so one id at a time is enough.
 */
let createdKeyId: string | null = null;

export function setCreatedKeyId(id: string): void {
  createdKeyId = id;
}

/** The created id, once: reading it clears the slot. */
export function takeCreatedKeyId(): string | null {
  const id = createdKeyId;
  createdKeyId = null;
  return id;
}
