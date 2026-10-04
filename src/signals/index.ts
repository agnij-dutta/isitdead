import type { Probe } from '../context.js';
import { dnsProbe } from './dns.js';
import { githubProbe } from './github.js';
import { jobsProbe } from './jobs.js';
import { npmProbe } from './npm.js';
import { tlsProbe } from './tls.js';
import { waybackProbe } from './wayback.js';
import { webProbe } from './web.js';
import { xProbe } from './x.js';

/**
 * The probe registry. To add a signal: write a probe in this folder, add its
 * signal name(s) to `SignalName` in types.ts, and append it here. Order only
 * affects output order; all applicable probes run concurrently.
 */
export const ALL_PROBES: Probe[] = [dnsProbe, webProbe, tlsProbe, githubProbe, npmProbe, xProbe, jobsProbe, waybackProbe];
