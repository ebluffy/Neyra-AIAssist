//! Serializes a chat ticket's dispatch with Stop/disconnect, before any side effect.
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct ChatDispatch(Mutex<u64>);

impl ChatDispatch {
    pub(crate) fn snapshot(&self) -> Result<u64, String> {
        self.0
            .lock()
            .map(|epoch| *epoch)
            .map_err(|_| "Chat lock poisoned".into())
    }

    pub(crate) fn dispatch<T>(
        &self,
        ticket: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let epoch = self.0.lock().map_err(|_| "Chat lock poisoned")?;
        if *epoch != ticket {
            return Err("Ход отменён. Отправьте сообщение заново.".into());
        }
        // Keep the lock through local scheduling or current_turn reservation + WSS enqueue.
        // Stop cannot slip between the check and the action.
        let result = action();
        drop(epoch);
        result
    }

    pub(crate) fn cancel<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut epoch = self.0.lock().map_err(|_| "Chat lock poisoned")?;
        *epoch = epoch.checked_add(1).ok_or("Chat epoch exhausted")?;
        action()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    };

    #[test]
    fn stop_before_delayed_dispatch_forbids_local_and_remote_execution_but_allows_new_turn() {
        let gate = Arc::new(ChatDispatch::default());
        let ticket = gate.snapshot().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let (start, delayed) = mpsc::channel();
        let worker_gate = gate.clone();
        let executed = count.clone();
        let worker = std::thread::spawn(move || {
            delayed.recv().unwrap();
            worker_gate.dispatch(ticket, || {
                executed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });
        gate.cancel(|| Ok(())).unwrap(); // Same production fence used by Stop/disconnect.
        start.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        gate.dispatch(gate.snapshot().unwrap(), || {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cancel_cannot_complete_between_dispatch_check_and_side_effect() {
        let gate = Arc::new(ChatDispatch::default());
        let ticket = gate.snapshot().unwrap();
        let (entered, in_action) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (stopped, stop_done) = mpsc::channel();
        let dispatch_gate = gate.clone();
        let dispatch = std::thread::spawn(move || {
            dispatch_gate.dispatch(ticket, || {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Ok(())
            })
        });
        in_action.recv().unwrap();
        assert!(gate.0.try_lock().is_err());
        let stop_gate = gate.clone();
        let stop = std::thread::spawn(move || {
            stop_gate
                .cancel(|| {
                    stopped.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
        });
        assert!(matches!(
            stop_done.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        release.send(()).unwrap();
        dispatch.join().unwrap().unwrap();
        stop.join().unwrap();
        stop_done.recv().unwrap();
        assert!(gate.dispatch(ticket, || Ok(())).is_err());
    }
}
