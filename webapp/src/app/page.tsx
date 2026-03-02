'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, Job } from '@/lib/supabase';

const PIPELINE_STEPS = [
  { key: 'pending', label: 'Queued', icon: '⏳' },
  { key: 'generating_jsons', label: 'Scripts', icon: '📝' },
  { key: 'generating_voice', label: 'Voices', icon: '🎙️' },
  { key: 'generating_images', label: 'Images', icon: '🖼️' },
  { key: 'stitching', label: 'Video', icon: '🎬' },
  { key: 'complete', label: 'Success', icon: '✅' },
];

// Edge TTS voices (Microsoft; no API key). Value = voice ShortName sent to pipeline.
const EDGE_TTS_VOICES = [
  { value: 'en-US-GuyNeural', label: 'Guy (US Male)' },
  { value: 'en-US-AriaNeural', label: 'Aria (US Female)' },
  { value: 'en-US-JennyNeural', label: 'Jenny (US Female)' },
  { value: 'en-US-DavisNeural', label: 'Davis (US Male)' },
  { value: 'en-GB-SoniaNeural', label: 'Sonia (UK Female)' },
  { value: 'en-GB-RyanNeural', label: 'Ryan (UK Male)' },
  { value: 'en-US-AndrewMultilingualNeural', label: 'Andrew (Multilingual)' },
  { value: 'en-US-EmmaMultilingualNeural', label: 'Emma (Multilingual)' },
];

function getStepState(jobStatus: string, stepKey: string) {
  const stepOrder = PIPELINE_STEPS.map(s => s.key);
  const currentIdx = stepOrder.indexOf(jobStatus);
  const stepIdx = stepOrder.indexOf(stepKey);
  if (jobStatus === 'error') return stepIdx < currentIdx ? 'done' : stepIdx === currentIdx ? 'error' : 'pending';
  if (stepKey === 'complete' && jobStatus === 'complete') return 'done';
  if (stepIdx < currentIdx) return 'done';
  if (stepIdx === currentIdx) return 'active';
  return 'pending';
}

function getStatusBadge(status: string) {
  if (status === 'complete') return { className: 'status-complete', dotClass: 'pulse-dot-complete', label: 'Complete' };
  if (status === 'error') return { className: 'status-error', dotClass: 'pulse-dot-error', label: 'Error' };
  if (status === 'pending') return { className: 'status-pending', dotClass: '', label: 'Pending' };
  return { className: 'status-processing', dotClass: 'pulse-dot-processing', label: 'Processing' };
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Form state
  const [script, setScript] = useState('');
  const [voiceName, setVoiceName] = useState(EDGE_TTS_VOICES[0].value);
  const [segmentCount, setSegmentCount] = useState(5);

  // Fetch jobs
  const fetchJobs = useCallback(async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(15);

    if (!error && data) {
      setJobs(data as Job[]);
      setSelectedJob(prev => {
        if (!prev) return null;
        const updated = data.find(j => j.id === prev.id);
        return updated ? (updated as Job) : prev;
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 3000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const lastJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    const container = logContainerRef.current;
    if (container && selectedJob) {
      // Check if this is the SAME job getting new logs
      const isSameJob = lastJobIdRef.current === selectedJob.id;
      lastJobIdRef.current = selectedJob.id;

      // Only auto-scroll if it's the same job AND user was already at the bottom
      const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 100;

      if (isSameJob && isAtBottom) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      } else if (!isSameJob) {
        // When switching jobs, scroll to top of logs
        container.scrollTop = 0;
      }
    }
  }, [selectedJob?.logs, selectedJob?.id]);

  // Submit new job
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!script.trim() || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: script.trim(), voice_name: voiceName, segment_count: segmentCount }),
      });
      const data = await res.json();
      if (data.success) {
        setScript('');
        fetchJobs();
      }
    } catch (err) {
      console.error('Submit error:', err);
    }
    setSubmitting(false);
  };

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 24px' }}>
      <div className="dashboard-grid">

        {/* ---- LEFT PANEL: Form + Job List ---- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Submit Form */}
          <div className="glass-card animate-fade-in" style={{ padding: 24 }}>
            <h2 className="form-label" style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: 20 }}>
              🚀 Start New Pipeline
            </h2>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label className="form-label">Script</label>
                <textarea
                  className="input-field"
                  placeholder="Paste your story or script... Flux will generate images for each part."
                  value={script}
                  onChange={e => setScript(e.target.value)}
                  rows={5}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 12 }}>
                <div>
                  <label className="form-label">Voice</label>
                  <select
                    className="input-field"
                    value={voiceName}
                    onChange={e => setVoiceName(e.target.value)}
                  >
                    {EDGE_TTS_VOICES.map(v => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="form-label">Segments</label>
                  <input
                    type="number"
                    className="input-field"
                    min={1}
                    max={60}
                    value={segmentCount}
                    onChange={e => setSegmentCount(Math.min(60, Math.max(1, parseInt(e.target.value) || 5)))}
                  />
                </div>
              </div>
              <button
                type="submit"
                className="btn-gradient"
                disabled={submitting || !script.trim()}
              >
                {submitting ? '⏳ Submitting...' : '✨ Generate Assets'}
              </button>
            </form>
          </div>

          {/* Job List */}
          <div className="glass-card" style={{ padding: 20 }}>
            <h2 className="form-label" style={{ marginBottom: 16 }}>Recent Tasks</h2>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 60, borderRadius: 12 }} />)}
              </div>
            ) : jobs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)' }}>No tasks yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {jobs.map((job) => {
                  const badge = getStatusBadge(job.status);
                  return (
                    <div
                      key={job.id}
                      className={`job-card glass-card ${selectedJob?.id === job.id ? 'active' : ''}`}
                      style={{ padding: '12px 16px', borderRadius: 10 }}
                      onClick={() => setSelectedJob(job)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                          {job.script.substring(0, 40)}...
                        </span>
                        <span className={`status-badge ${badge.className}`}>{badge.label}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <span>{job.segment_count} frames • {timeAgo(job.created_at)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ---- RIGHT PANEL: Job Detail ---- */}
        <div className="glass-card animate-fade-in" style={{ padding: 28, minHeight: 600 }}>
          {!selectedJob ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 500, color: 'var(--text-muted)', gap: 16 }}>
              <span style={{ fontSize: '3.5rem' }}>🖼️</span>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>Cloud Studio</p>
                <p style={{ fontSize: '0.85rem', maxWidth: 280, marginTop: 4 }}>Select a task from the list or start a new one to generate AI assets.</p>
              </div>
            </div>
          ) : (
            <div>
              {/* Detail Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 30 }}>
                <div>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Task Execution</h2>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: 4 }}>ID: {selectedJob.id}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className={`status-badge ${getStatusBadge(selectedJob.status).className}`}>
                    {selectedJob.status}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--accent-primary)', fontWeight: 700, marginTop: 8 }}>
                    {selectedJob.progress}%
                  </div>
                </div>
              </div>

              {/* Progress Tracker */}
              <div style={{ marginBottom: 32 }}>
                <div className="progress-bar" style={{ marginBottom: 20 }}>
                  <div className="progress-fill" style={{ width: `${selectedJob.progress}%` }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
                  {PIPELINE_STEPS.map((step) => {
                    const state = getStepState(selectedJob.status, step.key);
                    return (
                      <div key={step.key} style={{ textAlign: 'center' }}>
                        <div className={`step-icon step-${state}`} style={{ margin: '0 auto 8px', width: 44, height: 44, fontSize: '1.2rem' }}>
                          {state === 'done' ? '✓' : step.icon}
                        </div>
                        <p style={{ fontSize: '0.7rem', fontWeight: 600, color: state === 'active' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                          {step.label}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Current Status Section */}
              <div style={{ marginBottom: 32 }}>
                <h3 className="form-label" style={{ marginBottom: 10 }}>Current Activity</h3>
                <div style={{ padding: '14px 18px', background: 'rgba(99,102,241,0.08)', borderRadius: 12, border: '1px solid var(--border-glass)', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="pulse-dot pulse-dot-processing" />
                  <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>{selectedJob.current_task || 'Initializing...'}</span>
                </div>
              </div>

              {/* Execution Logs */}
              <div style={{ marginBottom: 32 }}>
                <h3 className="form-label" style={{ marginBottom: 10 }}>Live Execution Logs</h3>
                <div
                  className="log-container"
                  ref={logContainerRef}
                >
                  {selectedJob.logs && selectedJob.logs.length > 0 ? (
                    <>
                      {selectedJob.logs.map((log, idx) => (
                        <div key={idx} className="log-item">
                          <span className="log-timestamp">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                          <span className={`log-message log-${log.type}`}>{log.message}</span>
                        </div>
                      ))}
                      {selectedJob.status === 'error' && selectedJob.error_message && (
                        <div className="log-item">
                          <span className="log-timestamp">[{new Date().toLocaleTimeString()}]</span>
                          <span className="log-message log-error log-error-block">{selectedJob.error_message}</span>
                        </div>
                      )}
                    </>
                  ) : selectedJob.status === 'error' && selectedJob.error_message ? (
                    <div className="log-item">
                      <span className="log-timestamp">[{new Date().toLocaleTimeString()}]</span>
                      <span className="log-message log-error log-error-block">{selectedJob.error_message}</span>
                    </div>
                  ) : (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      Waiting for log data...
                    </div>
                  )}
                </div>
              </div>

              {/* Output Assets */}
              {selectedJob.status === 'complete' && (
                <div className="animate-fade-in" style={{ padding: 20, background: 'rgba(16,185,129,0.05)', borderRadius: 16, border: '1px solid rgba(16,185,129,0.2)', marginBottom: 32 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ color: 'var(--success)', fontWeight: 700, marginBottom: 4 }}>Task Complete!</h4>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>All assets generated and stored.</p>
                    </div>
                    <a
                      href={`https://supabase.com/dashboard/project/acpxzjrjhvvnwnqzgbxk/storage/buckets/pipeline_output?filter=${selectedJob.output_folder}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-gradient"
                      style={{ padding: '8px 20px', fontSize: '0.85rem', textDecoration: 'none' }}
                    >
                      Browse Assets
                    </a>
                  </div>
                </div>
              )}

              {/* Script Context */}
              <div>
                <h3 className="form-label" style={{ marginBottom: 10 }}>Script Context</h3>
                <div style={{ padding: 16, background: 'rgba(10,10,15,0.4)', borderRadius: 12, fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-secondary)', maxHeight: 120, overflowY: 'auto' }}>
                  {selectedJob.script}
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
