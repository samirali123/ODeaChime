# Evaluation set

`questions.jsonl`: one question per line with the expected answer.
**This is how we choose the on-site model and catch regressions**: run it
after every prompt, model or data-source change.

- `bells`: generated from BellForge's `schedules.json`; the expected
  answers are exact.
- `website`: lines marked **FILL IN** need a staff member to write the
  correct answer from odea.org or the handbook.
- `should-decline`: the assistant must refuse or say it doesn't know.

Grow this to 100–200 real staff questions during the pilot (the
`chat_log` table is the source). A runner script that asks each question
against `/api/chat` and grades the answers is the next piece to build.
Grading: exact match for bell times; Claude as grader for prose answers.
