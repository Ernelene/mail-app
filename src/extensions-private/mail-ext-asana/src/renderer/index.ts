/**
 * Renderer entry point for the Asana extension.
 *
 * Exports panel registrations that the private-extensions auto-loader
 * will discover and register with the panel component registry.
 */

import { AsanaPanel } from "./AsanaPanel";

export const panelRegistrations = [
  {
    extensionId: "asana",
    panelId: "asana-tasks",
    component: AsanaPanel,
  },
];
