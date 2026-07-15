Do not use a separate database for testing changes without asking.

Do NOT add verbosity. Build exactly what was asked — no intro paragraphs, descriptions, helper text, captions, or extra labels in the UI unless explicitly requested.

Use capitalised English. Do not use lowercase anywhere. Display strings live in data constants (label/title maps), not just JSX — check the source string, because CSS `text-transform: uppercase` masks lowercase strings until a restyle exposes them. When adding or restyling UI, verify the underlying string is capitalised, never rely on CSS to capitalise it. Units and keys stay lowercase.

Do NOT add colour unless explicitly asked. Default to a uniform, consistent, plain first proof of concept.

Never end a response with "say the word" or any offer-to-do-more tic ("just ask", "let me know if", "happy to"). State findings and stop.
