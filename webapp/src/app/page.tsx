'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase, Job } from '@/lib/supabase';

const PIPELINE_STEPS = [
  { key: 'pending', label: 'Queued', icon: '⏳' },
  { key: 'generating_jsons', label: 'Generating Scripts', icon: '📝' },
  { key: 'generating_voice', label: 'Generating Voice', icon: '🎙️' },
  { key: 'generating_images', label: 'Generating Images', icon: '🖼️' },
  { key: 'generating_videos', label: 'Generating Videos', icon: '🎬' },
  { key: 'stitching', label: 'Stitching & Assembly', icon: '🧩' },
  { key: 'complete', label: 'Complete', icon: '✅' },
];

function getStepState(jobStatus: string, stepKey: string) {
  const stepOrder = PIPELINE_STEPS.map(s => s.key);
  const currentIdx = stepOrder.indexOf(jobStatus);
  const stepIdx = stepOrder.indexOf(stepKey);
  if (jobStatus === 'error') return stepIdx <= currentIdx ? 'error' : 'pending';
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

  // Form state
  const [script, setScript] = useState('');
  const [voiceName, setVoiceName] = useState('denis');
  const [segmentCount, setSegmentCount] = useState(5);

  // Fetch jobs
  const fetchJobs = useCallback(async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!error && data) {
      setJobs(data as Job[]);
      // Update selected job if it exists
      if (selectedJob) {
        const updated = data.find(j => j.id === selectedJob.id);
        if (updated) setSelectedJob(updated as Job);
      }
    }
    setLoading(false);
  }, [selectedJob]);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 3000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

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
      } else {
        console.error('Submit failed:', data.error);
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
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🚀</span> New Job
            </h2>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label className="form-label">Script</label>
                <textarea
                  id="script-input"
                  className="input-field"
                  placeholder="Paste your script here... The AI will break it into segments, generate voiceovers, images, and videos for each."
                  value={script}
                  onChange={e => setScript(e.target.value)}
                  rows={5}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="form-label">Voice</label>
                  <select
                    id="voice-select"
                    className="input-field"
                    value={voiceName}
                    onChange={e => setVoiceName(e.target.value)}
                  >
                    <option value="denis">Denis</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div>
                  <label className="form-label">Segments</label>
                  <input
                    id="segment-count"
                    type="number"
                    className="input-field"
                    min={1}
                    max={30}
                    value={segmentCount}
                    onChange={e => setSegmentCount(parseInt(e.target.value) || 5)}
                  />
                </div>
              </div>
              <button
                id="submit-btn"
                type="submit"
                className="btn-gradient"
                disabled={submitting || !script.trim()}
              >
                {submitting ? '⏳ Submitting...' : '🎬 Generate Video'}
              </button>
            </form>
          </div>

          {/* Job List */}
          <div className="glass-card" style={{ padding: 20 }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16, color: 'var(--text-secondary)' }}>
              Recent Jobs
            </h2>
            {loading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[1, 2, 3].map(i => (
                  <div key={i} className="skeleton" style={{ height: 64, borderRadius: 12 }} />
                ))}
              </div>
            ) : jobs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                No jobs yet. Submit your first script above! ☝️
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {jobs.map((job) => {
                  const badge = getStatusBadge(job.status);
                  return (
                    <div
                      key={job.id}
                      className={`job-card glass-card ${selectedJob?.id === job.id ? 'active' : ''}`}
                      style={{ padding: '14px 16px', borderRadius: 12, cursor: 'pointer' }}
                      onClick={() => setSelectedJob(job)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                          {job.script.substring(0, 50)}...
                        </span>
                        <span className={`status-badge ${badge.className}`}>
                          {badge.dotClass && <span className={`pulse-dot ${badge.dotClass}`} />}
                          {badge.label}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {job.segment_count} segments • {job.voice_name}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {timeAgo(job.created_at)}
                        </span>
                      </div>
                      {job.status !== 'pending' && job.status !== 'complete' && job.status !== 'error' && (
                        <div className="progress-bar" style={{ marginTop: 8 }}>
                          <div className="progress-fill" style={{ width: `${job.progress}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ---- RIGHT PANEL: Job Detail ---- */}
        <div className="glass-card animate-fade-in" style={{ padding: 28, minHeight: 500 }}>
          {!selectedJob ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 450, color: 'var(--text-muted)', gap: 12 }}>
              <span style={{ fontSize: '3rem', opacity: 0.4 }}>🎬</span>
              <span style={{ fontSize: '0.95rem' }}>Select a job to view details</span>
              <span style={{ fontSize: '0.8rem', maxWidth: 300, textAlign: 'center', lineHeight: 1.5 }}>
                Submit a script to start the AI pipeline. Progress will update in real-time.
              </span>
            </div>
          ) : (
            <div>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 24 }}>
                <div>
                  <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: 4 }}>Job Details</h2>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                    {selectedJob.id.substring(0, 8)}...
                  </span>
                </div>
                {(() => {
                  const badge = getStatusBadge(selectedJob.status);
                  return (
                    <span className={`status-badge ${badge.className}`}>
                      {badge.dotClass && <span className={`pulse-dot ${badge.dotClass}`} />}
                      {badge.label}
                    </span>
                  );
                })()}
              </div>

              {/* Progress */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Progress</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent-primary)' }}>
                    {selectedJob.progress}%
                  </span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${selectedJob.progress}%` }} />
                </div>
              </div>

              {/* Pipeline Steps */}
              <div style={{ marginBottom: 24 }}>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Pipeline Steps
                </h3>
                {PIPELINE_STEPS.map((step) => {
                  const state = getStepState(selectedJob.status, step.key);
                  return (
                    <div key={step.key} className={`step-item step-${state}`}>
                      <div className="step-icon">
                        {state === 'done' ? '✓' : state === 'error' ? '✕' : step.icon}
                      </div>
                      <span style={{
                        fontSize: '0.9rem',
                        fontWeight: state === 'active' ? 600 : 400,
                        color: state === 'active' ? 'var(--text-primary)' : state === 'done' ? 'var(--success)' : 'var(--text-muted)',
                      }}>
                        {step.label}
                      </span>
                      {state === 'active' && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', marginLeft: 'auto' }}>
                          In progress...
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Error Message */}
              {selectedJob.error_message && (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 12, padding: 16, marginBottom: 24 }}>
                  <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f87171', marginBottom: 6 }}>Error</h3>
                  <p style={{ fontSize: '0.85rem', color: '#fca5a5', lineHeight: 1.5 }}>{selectedJob.error_message}</p>
                </div>
              )}

              {/* Output Link */}
              {selectedJob.status === 'complete' && selectedJob.output_folder && (
                <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 12, padding: 16, marginBottom: 24 }}>
                  <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: '#34d399', marginBottom: 8 }}>🎉 Output Ready!</h3>
                  <a
                    href={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/pipeline_output/${selectedJob.output_folder}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      color: '#34d399', fontSize: '0.9rem', fontWeight: 600, textDecoration: 'none',
                      padding: '8px 16px', background: 'rgba(16,185,129,0.1)', borderRadius: 8,
                    }}
                  >
                    📂 View in Storage
                  </a>
                </div>
              )}

              {/* Script Preview */}
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Script
                </h3>
                <div style={{
                  background: 'rgba(10,10,15,0.5)', borderRadius: 12, padding: 16,
                  fontSize: '0.85rem', lineHeight: 1.7, color: 'var(--text-secondary)',
                  maxHeight: 160, overflowY: 'auto',
                }}>
                  {selectedJob.script}
                </div>
              </div>

              {/* Metadata */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                {[
                  { label: 'Voice', value: selectedJob.voice_name, icon: '🎙️' },
                  { label: 'Segments', value: selectedJob.segment_count, icon: '📊' },
                  { label: 'Created', value: timeAgo(selectedJob.created_at), icon: '🕐' },
                ].map(m => (
                  <div key={m.label} style={{ background: 'rgba(10,10,15,0.4)', borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.2rem', marginBottom: 4 }}>{m.icon}</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{m.value}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>{m.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
