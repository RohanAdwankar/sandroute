# The optimisation tricks the providers use

What each platform does to fit more tenants on a host, how we know, and whether it was tried here. "Observed" means seen from
inside a box (the Claude Code probe, the Muse post), "documented" means stated by the project or paper, and "inferred" is
mine. The tenant count that matters on this 7 GiB machine is in `capacity.md`.

## Do not back memory until it is used

Claude Code starts the kernel with `deferred_init=lazy` (observed). Of the 16 GiB, only 3.2 GiB is initialised at boot, so the
host does not have to commit the rest. Transparent hugepages are on `madvise` and there are no static hugepages (observed), so
a page is only a huge page when a program asks, and nothing is reserved up front. E2B restores a sandbox by serving memory lazily
on page faults through userfaultfd (documented in its README), so a resume fetches only what the guest touches. Lambda counts
slots by function size and oversubscribes memory and CPU: tested above 20x, run in production at up to 10x (the Firecracker
paper). Not tried here: lazy init and hugepage settings matter in big guests, and ours is 256 MiB. Our restored VMs map one
shared snapshot copy on write, which has the same effect for the same reason, and it was the largest single gain (128 tenants to 416).

## Give memory back as it is freed

Claude Code and Muse both run a balloon with free page reporting (observed). Claude Code's reports in 2 MiB chunks
(`page_reporting_order=9`), has the statistics queue on, and deflates on out-of-memory. Muse's idle box costs its 2 GB working
set, not its 8 GB. Tried here with order 3: it moves the kept design from 128 to about 150 tenants and does nothing for the released
ones, which run out of CPU first. Not tried: order 9, which means fewer, larger reports and so less CPU for the same memory back.

## Do not keep idle VMs, or make keeping them cheap

Claude Code kills an idle VM and keeps its disk, and the one wake seen was a cold boot (observed once; the kernel has VMGENID,
so it could be restoring from a snapshot sometimes). E2B pauses idle sandboxes by writing memory and disk diffs against the
template to object storage, and prefers resuming on the node that still has them cached (documented). Muse keeps a VM per user
up and cheap with the balloon, pre-boots a pool of them, and replaces a VM per rollout rather than rebooting it (the Muse post).
Tried here: snapshot on idle (416 tenants), kill and cold boot (ran out of memory at 78 resident VMs, because a cold booted VM costs
about 123 MiB against about 37 restored), and keeping everything up (128). Not tried: diff snapshots, which write only the pages that
changed since the template and match what E2B does. That is the most promising one for oxroute, whose limit shows 65 to 80% disk wait
and 15 to 18 GiB of snapshots on disk, and Firecracker supports them.

## Make a boot cheap

Claude Code boots straight into its agent with `rdinit=/process_api`, no init system, uses `nomodule`, `random.trust_cpu=1` so the
kernel does not wait for entropy, and a custom stripped kernel (observed). It still took 1.82 s to reach the agent in the probe.
Firecracker itself is a minimal device model: under 5 MB of overhead per VM and a boot under 125 ms on its own kernel (the paper).
E2B avoids booting by restoring ("a sandbox is a resumed snapshot", documented). Tried here: the shared snapshot restore, which takes
about 54 ms. Not tried: the boot arguments, since we restore instead of boot.

## Cap the fixed costs that grow with RAM

`swiotlb=noforce` skips a bounce buffer the kernel allocates in a guest with more than 4 GB, and `dhash_entries` and `ihash_entries`
cap two lookup tables that otherwise grow with memory (observed, my reading of what they do). They pay off in a 16 GiB guest and
very little in a 256 MiB one, so they are not worth testing here.

## Share what every tenant has in common

Claude Code mounts the harness, its environment runner and the skills as small read-only disks shared across tenants (observed).
Muse has a dm-verity tools image and a read-only root with a throwaway encrypted overlay for scratch (the Muse post). E2B puts a
copy-on-write overlay over a read-only template image (documented). Here the root is one read-only ext4 with a tmpfs overlay, shared by
every VM, and the snapshot is shared as well.

## Thin disks

Claude Code's root is a 256 GiB ext4 mounted with `discard`, and only about 30 GiB of it is usable: the filesystem reserves the rest
for a uid (`resv_strict`, `resuid=65534`), which is a way to sell a big disk and commit a small one (observed, my reading). Not
relevant to the memory and CPU limits here.

## Mitigations scoped to the boundaries that exist

Claude Code boots with `mitigations=auto,no_guest_host,no_guest_guest`. That is mainline syntax, attack vector controls since
Linux 6.17 (`Documentation/admin-guide/hw-vuln/attack_vector_controls.rst`): `auto` turns on what the CPU needs, and the two `no_`
vectors drop the protections a kernel arms for VMs it hosts. Its guest kernel has KVM built in (the `kvm_pvm` line in dmesg), so
without them it would arm those protections for VMs it never runs. It keeps `user_kernel` and `user_user`, which guard the kernel
and the harness from the code the agent runs. Tenants are kept apart by the host, whose own guest mitigations nothing in a guest
can turn off (observed, plus the upstream document).

Not worth testing here. The 6.1.128 guest kernel predates the vector syntax, so the equivalent is `mitigations=off`, and the
i3-1115G4 is not affected by the expensive bugs (Meltdown, MDS, L1TF and Retbleed all read `Not affected`), so it would save a few
percent of guest CPU where the released designs stop on disk wait. A restored VM also keeps the boot arguments of the template,
so it would need the snapshot rebuilt.

The host matters more. Ubuntu builds 7.0.0-38-generic without `CONFIG_MITIGATION_GDS`, so Downfall reads `Vulnerable` although the
microcode (0xbe) supports the fix, and a hostile tenant could read another's data on the same core. `gather_data_sampling=force` on
the host command line turns the microcode mitigation on. Its cost falls on AVX gather instructions.

## Tried since: keep /tmp as files on the host

A guest that wrote to `/tmp` used to be kept as a 256 MiB memory snapshot, which cost most of the disk wait at oxroute's limit. Keeping scratch space as
host files like the workspace made those guests discardable and cut p99 at 576 tenants by about three times (see `capacity.md`). It is the cheap
version of what Claude Code does by keeping a disk and killing the VM.

## What this suggests trying next, in order

Now that disk wait is gone at 576, cpu is what is left, so diff snapshots matter less. Then `page_reporting_order=9`. Then THP and KSM (Claude Code's
kernel has `CONFIG_KSM=y`, but whether it is used is not shown), which could let identical pages across guests share memory.

## Warm the interpreter into the snapshot

The pristine snapshot is taken after the guest has booted, so whatever is in the guest's page cache at that moment is in every VM restored from it. Booting alone leaves the cache nearly empty, and the first command in a restored VM then reads its interpreter and libraries from the virtual disk. For `python3 -m unittest`, which imports a lot, that was a wake costing 530 ms of cpu and 307 ms of wall time. The init script now imports the commonly used standard library and runs a few shell utilities before the agent starts, and the same wake costs 161 ms of cpu and 116 ms of wall time.

I found this by accident. The first Rust guest agent was a static binary, and capacity fell: at 560 tenants the p99 went from 0.5 s to 4.6 s and the VMs used 45% more memory. The earlier agent was a Python program, so Python was always in the snapshot's page cache. Changing the agent language had removed a warm-up nobody knew was there. With the warm-up written down, 560 tenants have a p99 of 0.18 s, 2.1 GiB of VM memory instead of 3.2 GiB, and 30% mean cpu instead of 40%. The cache is shared copy on write across every restored VM, so it costs the host memory once.
