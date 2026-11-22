/**
 * The home page's sidebar: one section at a time, so the page is not one long
 * scroll. Every section keeps running while it is not shown, the sandbox's
 * terminal included. The chosen one is in the URL's hash, so it can be linked and
 * survives a reload. Without this script every section simply shows.
 */
const DEFAULT_VIEW = "shell";

export function mountSidebar(): void {
  const buttons = new Map<string, HTMLButtonElement>();
  for (
    const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-view-button]",
    )
  ) {
    buttons.set(button.dataset.viewButton!, button);
  }
  // A view can hold several sections: the shell and the Python cell work together.
  const sections = new Map<string, HTMLElement[]>();
  for (
    const section of document.querySelectorAll<HTMLElement>("[data-view]")
  ) {
    const view = section.dataset.view!;
    sections.set(view, [...sections.get(view) ?? [], section]);
  }
  // A view's name, or the id of anything inside one: #partner is in About.
  const fromHash = () => {
    const name = location.hash.slice(1);
    if (sections.has(name)) return name;
    return document.getElementById(name)?.closest<HTMLElement>("[data-view]")
      ?.dataset.view ?? DEFAULT_VIEW;
  };
  // What was asked for, kept when it is not offered yet: the agent appears a
  // moment after the page does, and #agent must still land on it.
  let wanted = fromHash();

  const show = () => {
    const offered = buttons.get(wanted)?.hidden === false &&
      sections.has(wanted);
    const current = offered ? wanted : DEFAULT_VIEW;
    for (const [name, members] of sections) {
      for (const section of members) {
        section.classList.toggle("view-off", name !== current);
      }
    }
    for (const [name, button] of buttons) {
      button.setAttribute("aria-current", String(name === current));
    }
    // A collapsible section chosen by name is there to be read.
    for (const shown of sections.get(current) ?? []) {
      if (shown instanceof HTMLDetailsElement) shown.open = true;
    }
  };

  // The page hides a section it does not offer here (no agent, no Python): its
  // button goes too, and the sidebar leaves it.
  const sync = () => {
    for (const [name, members] of sections) {
      const button = buttons.get(name);
      if (button) button.hidden = members.every((section) => section.hidden);
    }
    show();
  };
  const observer = new MutationObserver(sync);
  for (const section of [...sections.values()].flat()) {
    observer.observe(section, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }

  for (const [name, button] of buttons) {
    button.addEventListener("click", () => {
      history.replaceState(null, "", `#${name}`);
      wanted = name;
      show();
    });
  }
  addEventListener("hashchange", () => {
    wanted = fromHash();
    show();
  });
  document.documentElement.dataset.sidebar = "";
  sync();
}
