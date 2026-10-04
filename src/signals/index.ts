import type { Probe } from '../context.js';
import { dnsProbe } from './dns.js';
import { githubProbe } from './github.js';
import { jobsProbe } from './jobs.js';
import { npmProbe } from './npm.js';
import { tlsProbe } from './tls.js';
import { waybackProbe } from './wayback.js';
import { webProbe } from './web.js';
import { xProbe } from './x.js';

export const ALL_PROBES: Probe[] = [dnsProbe, webProbe, tlsProbe, githubProbe, npmProbe, xProbe, jobsProbe, waybackProbe];
