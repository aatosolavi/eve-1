import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineInstructions({
        markdown: "You are a retained epoch-1 dynamic instructions prompt.",
      }),
  },
});
