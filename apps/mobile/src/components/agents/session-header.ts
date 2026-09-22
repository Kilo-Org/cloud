/**
 * Line cap for the session header's primary heading.
 *
 * The session name is the screen's identity and is often a full sentence
 * ("Tax export formatter test"). At two lines it truncated mid-word beside the
 * back control and the context/copy cluster on a narrow window, so the loaded
 * header and the route's loading and error headers share this cap: the reserved
 * title box is then identical before and after the loaded header swaps in, and
 * the primary heading stays readable.
 */
export const SESSION_HEADER_TITLE_LINES = 3;
