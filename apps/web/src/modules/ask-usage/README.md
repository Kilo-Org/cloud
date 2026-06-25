# Ask Usage

Ask Usage turns validated dataset tool results into first-party React UI. The trust boundary is intentionally narrow:

```text
User question
-> model calls the allowlisted dataset tool
-> Cloud Agent preserves structuredContent
-> app validates input and output schemas
-> app chooses metric cards, chart, or table
-> React renders the trusted component
```

Assistant prose stays prose. The model never supplies HTML, JavaScript, chart code, React components, or executable markup for the app to render.

Leaked control markup can appear in old or misbehaving model output, for example:

```html
<function_result>
  <invoke name="kilo_usage_render_result">
    <parameter name="type">chart</parameter>
    <parameter name="title">Code Review Costs (Last Week)</parameter>
    <parameter name="data">
      [{"date":"2026-06-23","totalCostUsd":0.05209422}]
    </parameter>
  </invoke>
</function_result>
```

That block is not a rendering protocol. It is stripped from assistant text because it is model-authored markup, not a real tool result.

The supported path looks like this:

```text
Tool: kilo_usage/query_kilo_dataset
Input: code_reviews, timeseries by day, sum totalCostUsd
Output: structuredContent with validated rows for Jun 18-24
```

The user sees application-owned UI such as:

```text
Code Review Costs (Last Week)

Jun 18  $0.00
Jun 19  $0.00
...
Jun 23  $0.052
Jun 24  $0.048
```

The app converts validated rows into props for allowlisted chart and table components. React turns those components into DOM elements and SVG managed by the application.

For renderer details, start in `client/rendering/`. For the data contract, use the shared Kilo dataset input and output schemas.
