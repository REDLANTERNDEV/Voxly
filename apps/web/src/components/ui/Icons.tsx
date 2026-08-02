export function ArrowIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>; }
export function ChatIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v9H9l-4 4z" /></svg>; }
export function MenuIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" /><path d="M5 12h14" /><path d="M5 17h14" /></svg>; }
export function UsersIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" /><circle cx="12" cy="9" r="3" /></svg>; }
export function ShieldIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 19 7v5c0 4-2.7 6.7-7 8-4.3-1.3-7-4-7-8V7z" /><path d="M9 12h6" /></svg>; }
export function UserPlusIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" /><circle cx="10" cy="9" r="3" /><path d="M18 9v6" /><path d="M15 12h6" /></svg>; }
export function LinkIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-6-.5l-2 2A4 4 0 0 0 11.7 17l1-1" /></svg>; }
export function PlusIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>; }
export function CopyIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v10H8z" /><path d="M6 14H5a1 1 0 0 1-1-1V5h8a1 1 0 0 1 1 1v1" /></svg>; }
export function CloseIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12" /><path d="m18 6-12 12" /></svg>; }
export function EditIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 16-1 4 4-1L19 8l-3-3Z" /><path d="m14 7 3 3" /></svg>; }
export function TrashIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12" /><path d="M9 7V5h6v2" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M8 7l1 12h6l1-12" /></svg>; }
export function LeaveIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8 4 12l4 4" /><path d="M4 12h11" /><path d="M14 5h5v14h-5" /></svg>; }
export function MaximizeIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5" /><path d="M16 3h5v5" /><path d="M21 16v5h-5" /><path d="M3 16v5h5" /></svg>; }
export function EyeIcon({ off = false }: { off?: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" /><circle cx="12" cy="12" r="2.5" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
export function MoreIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>; }
export function VolumeIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h4l5-4v12l-5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6" /><path d="M19 6a8 8 0 0 1 0 12" /></svg>; }
export function MicIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v3" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
export function HeadsetIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 14v-2a7 7 0 0 1 14 0v2" /><path d="M5 14h3v5H6a1 1 0 0 1-1-1z" /><path d="M16 14h3v4a1 1 0 0 1-1 1h-2z" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
export function CameraIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4z" /><path d="m17 11 3-2v6l-3-2z" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
export function ScreenIcon({ off }: { off: boolean }) {
  return (
    <svg className="ui-icon screen-icon" viewBox="0 0 256 256" aria-hidden="true">
      <rect x="32" y="48" width="192" height="144" rx="16" transform="translate(256 240) rotate(180)" />
      <line x1="160" y1="224" x2="96" y2="224" />
      <polyline points="104 112 128 88 152 112" />
      <line x1="128" y1="88" x2="128" y2="152" />
      {off ? <line x1="32" y1="32" x2="224" y2="224" /> : null}
    </svg>
  );
}
