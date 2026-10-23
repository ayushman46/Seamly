import { Component, type ReactNode } from "react";

export default class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("Seamly UI error", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice warn" role="alert" style={{ margin: 12 }}>
        <div>
          <b>{this.props.label ?? "This panel"} hit an unexpected problem.</b>
          <div className="faint" style={{ fontSize: 12, marginTop: 4, overflowWrap: "anywhere" }}>{this.state.error.message}</div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
