// The browser agent may need many tool rounds.
// Page-reading tasks inspect the page one tool call at a time.
// Workflow tasks can require dozens of rounds before the model reports a result.
// Keep this ceiling above both.
export const maxAgentToolRounds = 60;
