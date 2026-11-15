/** Puts the React panel into the element the plugin host gives the floating panel. */
import { createRoot } from "react-dom/client";
import type { EuddraftController } from "../controller";
import { EuddraftPanel } from "./EuddraftPanel";
import "./euddraft.css";

export function mountEuddraft(body: HTMLElement, controller: EuddraftController, mapName: () => string | null): () => void {
  const root = createRoot(body);
  root.render(<EuddraftPanel controller={controller} mapName={mapName} />);
  return () => root.unmount();
}
