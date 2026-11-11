{% if recurring_findings.size > 0 %}
## Recurring findings

These finding categories recur (`same_issue`: again in this issue; `cross_issue`: in several issues of this repository within the last days). A recurring `blocker` or `major` finding of your review needs a lesson for the developer (see `lessons` below):
{% for entry in recurring_findings %}
- `{{ entry.category }}` ({{ entry.triggers | join: ", " }}; {{ entry.findings }} finding(s) in {{ entry.issues | join: ", " }}): {% if entry.lesson %}lesson `{{ entry.lesson.path }}` ({{ entry.lesson.status }}){% else %}no lesson yet{% endif %}{% for example in entry.examples %}
  - {{ example.issue }}: {{ example.problem }}{% endfor %}{% endfor %}
{% endif %}{% if known_categories.size > 0 %}
Finding categories already used in this repository (reuse the one that fits, so the same pattern keeps its name): {% for known in known_categories %}`{{ known.category }}` ({{ known.issues.size }} issue(s)){% unless forloop.last %}, {% endunless %}{% endfor %}.
{% endif %}
