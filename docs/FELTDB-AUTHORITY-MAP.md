# FeltDB Authority Map

Complete inventory of all persistent state in Grok Bot 0.18 Reconstructed.

| State Domain | Current Owner | Durable? | Authority | Process-Local? | Derived? | FeltDB Candidate | Priority | Comments |
|---|---|---|---|---|---|---|---|---|
| **Settings** | | | | | | | | |
| Theme preference | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Medium | Atomic write via temp file |
| Update track | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Medium | Rarely changed |
| MCP box servers | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Medium | Configuration |
| MCP custom instructions | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Medium | Per-server config |
| MCP disabled tools | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Medium | Tool filtering |
| Egress tunnel enabled | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Low | Toggle setting |
| WebAuthn proxy enabled | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Low | Toggle setting |
| Auto-review instructions | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Low | Agent configuration |
| Local tool permission | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Low | Permissions |
| Timezone override | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Low | User preference |
| Agent default model | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Medium | Model selection |
| Computer use model | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Low | Model selection |
| Inference provider | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | High | Router provider choice |
| Box runtime | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | High | Remote vs. local Docker |
| Sidebar sections | Electron main (JSON) | Yes | SandSettingsStore | No | No | YES | Low | UI state |
| **Session & Conversation** | | | | | | | | |
| Session identity | Host (blob store) | Partial | AgentStore | Depends | No | YES | Critical | Currently in-memory |
| Conversation turns | Host (blob store) | Partial | ConversationTurn proto | Depends | No | YES | Critical | Needs durability |
| Conversation state | Host (blob store) | Partial | ConversationState proto | Depends | No | YES | Critical | State machine |
| Conversation summary | Host (blob store) | Partial | ConversationSummary | Depends | No | YES | Medium | Derived from turns |
| Agent metadata | Host (blob store) | Partial | AgentMetadata | Depends | No | YES | High | Mode, model, plan |
| Subagent references | Host (blob store) | Partial | SubagentInfo | Depends | No | YES | High | Parent/child tracking |
| **Execution & Tools** | | | | | | | | |
| Turn execution status | Runtime memory | No | In-process promises | Yes | No | YES | Critical | No durable tracking |
| Tool call state | Runtime memory | No | Tool execution loop | Yes | No | YES | Critical | Needs durability |
| Tool execution results | Blob store | Partial | Serialized result | Depends | No | YES | High | Success/error tracking |
| Idempotency tracking | None | No | Not tracked | Yes | N/A | YES | Critical | **MISSING** |
| Execution checkpoints | None | No | Not persisted | Yes | N/A | YES | Critical | **MISSING** |
| Error & retry state | Runtime memory | No | Error handlers | Yes | No | YES | High | Retry logic |
| **Coordinator State** | | | | | | | | |
| Transcript routing | Coordinator memory | No | Coordinator process | Yes | No | YES | High | Message routing table |
| Streaming activity | Coordinator memory | No | Coordinator process | Yes | No | YES | Medium | Active streams |
| Message queue | Coordinator memory | No | Message buffers | Yes | No | YES | High | **MISSING DURABILITY** |
| Reaction events | Coordinator memory | No | Event handlers | Yes | No | YES | Medium | User reactions |
| MCP bridge state | Coordinator memory | No | Router state | Yes | No | YES | Medium | Tool routing |
| **Usage & Analytics** | | | | | | | | |
| Request count | Settings (JSON) | Yes | SandInferenceRouterUsage | No | No | YES | Low | Periodic persistence |
| Token usage | Settings (JSON) | Yes | SandInferenceRouterUsage | No | No | YES | Low | By provider |
| Cache metrics | Settings (JSON) | Yes | SandInferenceRouterUsage | No | No | YES | Low | Read/write tokens |
| Last used timestamp | Settings (JSON) | Yes | SandInferenceRouterUsage | No | No | YES | Low | Activity tracking |
| **Auth & Secrets** | | | | | | | | |
| Provider API keys | System keychain | Yes | Electron secrets API | No | No | NO | N/A | **NEVER in FeltDB** |
| OAuth tokens | System keychain | Yes | Electron secrets API | No | No | NO | N/A | **NEVER in FeltDB** |
| Refresh tokens | System keychain | Yes | Electron secrets API | No | No | NO | N/A | **NEVER in FeltDB** |
| Session credentials | Memory | No | Process-local | Yes | N/A | NO | N/A | **KEEP EPHEMERAL** |
| **MCP & Plugins** | | | | | | | | |
| MCP server catalog | Memory cache | No | Runtime objects | Yes | Yes | Partial | Low | Can rebuild from servers |
| Tool inventory | Memory cache | No | Runtime objects | Yes | Yes | NO | N/A | Ephemeral projection |
| Resource definitions | Memory cache | No | Runtime objects | Yes | Yes | NO | N/A | Ephemeral projection |
| Capabilities cache | Memory cache | No | Runtime objects | Yes | Yes | NO | N/A | Ephemeral projection |
| **Provider & Box** | | | | | | | | |
| Box connection state | Memory | No | Coordinator/Host | Yes | N/A | NO | N/A | Ephemeral |
| Docker container refs | Memory | No | Coordinator | Yes | N/A | NO | N/A | Ephemeral |
| Tunnel connections | Memory | No | Box handlers | Yes | N/A | NO | N/A | Ephemeral |
| Provider connection | Memory | No | Runtime objects | Yes | N/A | NO | N/A | Ephemeral |
| **Rendition State** | | | | | | | | |
| UI form state | DOM | No | React state | Yes | N/A | NO | N/A | Ephemeral per session |
| Scroll position | DOM | No | React/DOM | Yes | N/A | NO | N/A | Ephemeral |
| Modal/dialog state | React | No | React state | Yes | N/A | NO | N/A | Ephemeral |
| Selection state | React | No | React state | Yes | N/A | NO | N/A | Ephemeral |

---

## Analysis by Process

### Electron Main

**Manages Durably:**
- Settings (JSON → FeltDB)
- Secrets (System keychain, NOT FeltDB)

**Manages Ephemerally:**
- Coordinator process handle
- Box connector state
- Renderer bridge ports

### Host Process

**Manages Durably:**
- Session/turn state (Blob → FeltDB)
- Execution records (Blob → FeltDB)
- Tool execution (Blob → FeltDB)

**Manages Ephemerally:**
- In-flight inference requests
- Active tool processes
- Provider connections
- MCP runtime state
- Streaming buffers

### Coordinator Process

**Manages Durably:**
- Message routing (none currently → FeltDB)
- Event log (none currently → FeltDB)

**Manages Ephemerally:**
- Active stream handles
- Message buffers
- Router state
- Socket connections

### Renderer

**Manages Only Ephemerally:**
- UI state (forms, modals, selection)
- Scroll position
- Streaming display buffers

---

## Authority Bugs Summary

### Critical Issues

1. **No Durable Execution State**
   - Turn execution has no durable record
   - Partial execution is lost on crash
   - Tool results not reliably persisted
   - **Risk:** Data loss, incorrect re-execution

2. **Missing Idempotency Tracking**
   - No idempotency keys on tool calls
   - Cannot distinguish retries from duplicates
   - **Risk:** Tool side effects applied twice

3. **No Coordinator Durability**
   - Message queue lost on coordinator crash
   - In-flight turns become orphaned
   - **Risk:** Message loss, streaming interruptions

4. **Implicit Session Identity**
   - Session IDs may not survive restart
   - Conversation history may fragment
   - **Risk:** Conversation continuity broken

### Moderate Issues

5. **Provider Routing State**
   - Split between settings (durable) and memory (ephemeral)
   - No coordination between Electron main and host
   - **Risk:** Inconsistent provider selection

6. **Usage Records**
   - Only periodically persisted
   - Loss if crash before periodic save
   - **Risk:** Incomplete usage data

7. **MCP Server State**
   - All in-memory; lost on restart
   - No persistent record of connected servers
   - **Risk:** Must re-negotiate servers on startup

---

## FeltDB Migration Roadmap

### High Priority (Phase 1-2)
- [ ] Settings (low risk, high value for example)
- [ ] Session identity
- [ ] Turn lifecycle
- [ ] Execution state

### Medium Priority (Phase 3)
- [ ] Coordinator message queue
- [ ] Tool call tracking
- [ ] Usage records

### Low Priority (Phase 4+)
- [ ] MCP server metadata (if useful)
- [ ] Provider routing (if needed for coordination)

---

## State Patterns Observed

### Atomic Write Pattern (Good)
**Used by:** SandSettingsStore  
**Pattern:** Write to temp file, rename to target  
**Benefit:** Prevents corruption on crash  
**FeltDB Equivalent:** Single atomic write

### Blob + Metadata Pattern (Needs Durability)
**Used by:** AgentStore + BlobStore  
**Pattern:** Metadata pointers to blobs stored separately  
**Benefit:** Deduplication, compression  
**Issue:** Blobs not durable by default (in-memory)  
**FeltDB Equivalent:** FeltDB blob storage

### Process-Local Accumulator (Risky)
**Used by:** Usage records, coordinator state  
**Pattern:** Accumulate in memory, periodic flush  
**Benefit:** Performance  
**Issue:** Loss on crash, no ordering guarantees  
**FeltDB Equivalent:** Durable append with flush semantics

### Fire-and-Forget Async (Risky)
**Used by:** Tool execution, message routing  
**Pattern:** Start async work, don't track completion  
**Benefit:** Non-blocking  
**Issue:** No recovery on crash, idempotency unknown  
**FeltDB Equivalent:** Durable operation tracking

---

**Document Status:** Initial Draft  
**Last Updated:** 2026-08-24  
**Next:** Detailed authority model per collection
