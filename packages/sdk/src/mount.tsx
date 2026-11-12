import { render } from "solid-js/web";
import { EditorView, type EditorViewProps } from "./editor-view";

/**
 * Mount the editor into a container, for hosts that don't use Solid. Returns a function that
 * unmounts it and releases its viewport, listeners and GPU resources. The Editor itself stays
 * with the caller.
 */
export function mountEditor(container: HTMLElement, props: EditorViewProps): () => void {
  return render(() => <EditorView {...props} />, container);
}
