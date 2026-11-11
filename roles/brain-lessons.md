{% if brain_lessons and brain_lessons.total > 0 %}
## Lessons of this repository

Lessons from the knowledge vault for this repository{% if results.open_findings.size > 0 or results.security_findings.size > 0 %}, the ones for the categories of the open findings first{% endif %}. Follow them while you work; read a lesson with `brain_read` when you need more than its rule. A candidate is not reviewed yet: check it against the code before you rely on it.
{% for lesson in brain_lessons.lessons %}
- **{{ lesson.title }}** (`{{ lesson.path }}`{% if lesson.candidate %}, candidate: check it against the code{% endif %}{% if lesson.categories.size > 0 %}, categories: {{ lesson.categories | join: ", " }}{% endif %}){% if lesson.rule != "" %}: {{ lesson.rule }}{% endif %}{% endfor %}
{% if brain_lessons.more.size > 0 %}
More lessons, by path (read them with `brain_read` where the issue touches their topic): {% for more in brain_lessons.more %}`{{ more }}`{% unless forloop.last %}, {% endunless %}{% endfor %}.
{% endif %}{% endif %}
