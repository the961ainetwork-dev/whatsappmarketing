-- WA-MARKETER · multi-tenant WhatsApp marketing platform
create table if not exists wm_users (
  id bigint generated always as identity primary key,
  email text unique not null,
  pass_hash text not null,
  salt text not null,
  token text unique not null,
  plan text default 'free',
  created_at timestamptz default now()
);

create table if not exists wm_settings (
  user_id bigint primary key references wm_users(id) on delete cascade,
  phone_number_id text,
  waba_id text,
  access_token text,
  business_name text,
  ai_enabled boolean default false,
  ai_prompt text,          -- business context for the auto-responder
  updated_at timestamptz default now()
);

create table if not exists wm_contacts (
  id bigint generated always as identity primary key,
  user_id bigint not null references wm_users(id) on delete cascade,
  phone text not null,
  name text,
  category text default 'general',
  interest text,
  opt_in boolean default true,
  source text default 'manual',   -- manual | csv | inbound
  created_at timestamptz default now(),
  unique(user_id, phone)
);
create index if not exists wm_contacts_user on wm_contacts(user_id);
create index if not exists wm_contacts_cat on wm_contacts(user_id, category);

create table if not exists wm_messages (
  id bigint generated always as identity primary key,
  user_id bigint not null references wm_users(id) on delete cascade,
  phone text not null,
  direction text not null,        -- in | out
  body text,
  wa_id text,
  kind text default 'text',       -- text | template | ai
  created_at timestamptz default now()
);
create index if not exists wm_messages_user on wm_messages(user_id, phone, created_at);

create table if not exists wm_campaigns (
  id bigint generated always as identity primary key,
  user_id bigint not null references wm_users(id) on delete cascade,
  name text not null,
  mode text default 'template',   -- template | text (text only reaches 24h-active chats)
  template_name text,
  lang text default 'en',
  body text,                      -- for text mode, or template var preview
  var1_field text default 'name', -- contact field substituted into {{1}}
  category text default 'all',
  status text default 'draft',    -- draft | scheduled | sending | done | failed
  scheduled_at timestamptz,
  cursor bigint default 0,        -- last contact id processed (resumable batches)
  sent int default 0,
  failed int default 0,
  created_at timestamptz default now()
);

create table if not exists wm_drips (
  id bigint generated always as identity primary key,
  user_id bigint not null references wm_users(id) on delete cascade,
  name text not null,
  category text default 'all',    -- new contacts in this category auto-enroll
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists wm_drip_steps (
  id bigint generated always as identity primary key,
  drip_id bigint not null references wm_drips(id) on delete cascade,
  day_offset int not null,        -- days after enrollment
  mode text default 'template',
  template_name text,
  lang text default 'en',
  body text,
  var1_field text default 'name'
);

create table if not exists wm_drip_state (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  drip_id bigint not null references wm_drips(id) on delete cascade,
  contact_id bigint not null references wm_contacts(id) on delete cascade,
  step_index int default 0,
  next_at timestamptz not null,
  done boolean default false,
  unique(drip_id, contact_id)
);
create index if not exists wm_drip_due on wm_drip_state(done, next_at);

alter table wm_users enable row level security;
alter table wm_settings enable row level security;
alter table wm_contacts enable row level security;
alter table wm_messages enable row level security;
alter table wm_campaigns enable row level security;
alter table wm_drips enable row level security;
alter table wm_drip_steps enable row level security;
alter table wm_drip_state enable row level security;

-- v2: demo mode, user approval, activity tracking
alter table wm_users add column if not exists status text default 'pending';   -- pending | active | suspended | rejected | demo
alter table wm_users add column if not exists demo_expires timestamptz;
alter table wm_users add column if not exists last_seen timestamptz;

create table if not exists wm_events (
  id bigint generated always as identity primary key,
  user_id bigint,
  email text,
  event text not null,
  meta text,
  created_at timestamptz default now()
);
create index if not exists wm_events_time on wm_events(created_at desc);
alter table wm_events enable row level security;

-- v3: daily owner report
alter table wm_settings add column if not exists owner_phone text;
alter table wm_settings add column if not exists daily_summary boolean default false;

-- v4: sales AI, segments, anti-ban, analytics
alter table wm_contacts add column if not exists intent text default 'cold';       -- cold | warm | hot
alter table wm_contacts add column if not exists order_note text;
alter table wm_contacts add column if not exists last_inbound timestamptz;
alter table wm_contacts add column if not exists intent_at timestamptz;
alter table wm_messages add column if not exists status text;                       -- sent | delivered | read | failed
alter table wm_messages add column if not exists campaign_id bigint;
alter table wm_settings add column if not exists warmup boolean default true;
alter table wm_settings add column if not exists first_send_at timestamptz;
create index if not exists wm_messages_waid on wm_messages(wa_id);
create index if not exists wm_contacts_intent on wm_contacts(user_id, intent);

-- v5: agency workspaces
alter table wm_users add column if not exists parent_id bigint;
create index if not exists wm_users_parent on wm_users(parent_id);
