// PRD §8.1 model-pin policy: "模型 pin 在 config" — the model pin is a single
// named export, not a string literal scattered per route file. Every stage
// route (FIT-01/FIT-02, TLR-01, PRP-01/PRP-02) and the eval judge harness
// (EVL-02) import these constants; a model upgrade is a one-line diff here
// whose blast radius is exactly what PRD §6's Q1–Q3 quality gates exist to
// catch. No other file in the repo may hardcode either model name string
// (enforced by code-review convention — see the ticket's Deliverable 1 note;
// this file cannot enforce it mechanically across future tickets).

export const PRIMARY_MODEL = 'claude-sonnet-5';
export const JUDGE_MODEL = 'claude-haiku-4-5';
