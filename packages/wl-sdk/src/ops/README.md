# ops

Higher-level operations composed over the DoltHub client. Each op encapsulates
a multi-step workflow (e.g. open branch → write rows → open PR → poll merge).

Concrete ops files will be added by follow-up tasks. Expected shape: one file
per op, exporting a single async function plus its input/output types.
