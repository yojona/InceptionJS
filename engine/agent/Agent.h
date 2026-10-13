#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class FormState;
class NavigationAction;
class ResourceRequest;
}

namespace Inception::Agent {

// The engine side of the agent namespace (host/agent.js): page snapshots read
// from the accessibility tree, actions delivered through the same input path
// a person's input takes, and the queries waitFor polls. Nothing here runs
// script in the page. Every command carries an id and is answered with
// "agent.result" {id, ...}, or {id, error: {code, message}}.
void registerCommands();

// While the agent holds control, a form submission or a download goes ahead
// only if the embedder's policy approved its risk for the current action;
// anything else is refused here and reported as "agent.blocked".
bool allowsNavigation(const WebCore::NavigationAction&, const WebCore::ResourceRequest&, WebCore::FormState*);
bool allowsDownload(const URL&);

} // namespace Inception::Agent
