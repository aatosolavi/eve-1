import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineSkill({
        description: "Share a retained epoch-1 dynamic skill.",
        markdown: "# Playbook\n\nFollow the retained skill contract.\n",
      }),
  },
});
