-- Custom SQL migration file, put your code below! --
UPDATE "custom_llm2" SET "definition" = "definition" - 'pricing' WHERE "definition" ? 'pricing';
