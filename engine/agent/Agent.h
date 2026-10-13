#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class FormState;
class NavigationAction;
class ResourceRequest;
}

namespace Inception {
class View;
}

namespace Inception::Agent {

// The engine side of the agent namespace (host/agent.js): page snapshots read
// from the accessibility tree, actions delivered through the same input path
// a person's input takes, and the queries waitFor polls. Nothing here runs
// script in the page. Every command carries an id and is answered with
// "agent.result" {id, ...}, or {id, error: {code, message}}.
void registerCommands();

// Agent state (control, approvals, issued refs) is per window: a command acts
// on its own window's state only.
//
// While the agent holds control of a tab's window, a form submission or a
// download there goes ahead only if the embedder's policy approved its risk
// for the current action; anything else is refused here and reported as
// "agent.blocked".
bool allowsNavigation(View&, const WebCore::NavigationAction&, const WebCore::ResourceRequest&, WebCore::FormState*);
bool allowsDownload(View&, const URL&);

// Drops a closed window's state.
void windowClosed(unsigned window);

} // namespace Inception::Agent
