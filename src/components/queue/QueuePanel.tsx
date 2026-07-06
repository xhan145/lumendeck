import { useStudio } from '../../state/store';

export function QueuePanel() {
  const queue = useStudio((s) => s.queue);
  if (queue.length === 0) return null;
  const statusLabel = (status: string) => status === 'done_with_warning' ? 'done + warning' : status;
  return (
    <section className="rail-section">
      <h3>Queue</h3>
      {queue.map((job) => (
        <div key={job.id} className="queue-item">
          <div className="queue-row">
            {job.previewDataUrl ? (
              <img className="queue-preview" src={job.previewDataUrl} alt="" />
            ) : (
              <div className="queue-preview empty" />
            )}
            <div className="queue-main">
              <div className="queue-label">
                <span title={job.label}>{job.label}</span>
                <span className={`status-${job.status}`}>{statusLabel(job.status)}</span>
              </div>
              <div className="progress" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${job.progress * 100}%` }} />
              </div>
              <div className="queue-phase">{job.phase ?? `${Math.round(job.progress * 100)}%`}</div>
            </div>
          </div>
          {job.fallbackReason ? <div className="queue-warning">{job.fallbackReason}</div> : null}
          {job.error && !job.fallbackReason ? <div className="queue-error">{job.error}</div> : null}
        </div>
      ))}
    </section>
  );
}
