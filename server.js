const express = require('express');
const WebTorrent = require('webtorrent');
const archiver = require('archiver');
const path = require('path');

const app = express();
const client = new WebTorrent();

// لتقديم ملفات الواجهة الأمامية
app.use(express.static('public'));
app.use(express.json());

// متتبع للملفات النشطة حتى لا يتم حذفها أثناء تحميل مستخدم آخر لها
const activeDownloads = {};

// 1. واجهة جلب بيانات التورنت (الأسماء والأحجام)
app.post('/api/metadata', (req, res) => {
    const { magnet } = req.body;
    if (!magnet) return res.status(400).json({ error: 'الرابط المغناطيسي مطلوب' });

    let torrent = client.get(magnet);

    const sendMetadata = (t) => {
        res.json({
            name: t.name,
            infoHash: t.infoHash,
            files: t.files.map((f, index) => ({
                index,
                name: f.name,
                size: f.length
            }))
        });
    };

    if (torrent && torrent.ready) {
        return sendMetadata(torrent);
    } else if (torrent) {
        torrent.on('ready', () => sendMetadata(torrent));
    } else {
        // تحميل الملفات مؤقتاً في مجلد tmp الخاص بالسيرفر
        torrent = client.add(magnet, { path: '/tmp/webtorrent' });
        
        // مهلة 20 ثانية إذا كان التورنت ميت (لا يوجد Seeders)
        const timeout = setTimeout(() => {
            client.remove(magnet);
            if (!res.headersSent) res.status(504).json({ error: 'انتهى الوقت. لا يوجد Seeders لهذا التورنت.' });
        }, 20000);

        torrent.on('metadata', () => {
            clearTimeout(timeout);
            sendMetadata(torrent);
        });
    }
});

// 2. واجهة تنزيل الملفات (مفردة أو Zip)
app.get('/download', (req, res) => {
    const { infoHash, files } = req.query;
    if (!infoHash || !files) return res.status(400).send('بيانات ناقصة');

    const torrent = client.get(infoHash);
    if (!torrent) return res.status(404).send('انتهت صلاحية التورنت، يرجى إعادة إدخال الرابط.');

    const indices = files.split(',').map(Number);
    const selectedFiles = torrent.files.filter((_, i) => indices.includes(i));

    if (selectedFiles.length === 0) return res.status(404).send('لم يتم العثور على الملفات');

    // تسجيل أن هناك مستخدم يحمل الآن
    activeDownloads[infoHash] = (activeDownloads[infoHash] || 0) + 1;

    // عند انتهاء التحميل أو إغلاق المستخدم للمتصفح
    res.on('close', () => {
        activeDownloads[infoHash] -= 1;
        // إذا لم يعد هناك أحد يحمل هذا التورنت، قم بحذفه من السيرفر لتفريغ المساحة
        if (activeDownloads[infoHash] <= 0) {
            delete activeDownloads[infoHash];
            if (client.get(infoHash)) {
                client.remove(infoHash, { destroyStore: true }, () => {
                    console.log(`تم مسح ملفات التورنت من السيرفر: ${infoHash}`);
                });
            }
        }
    });

    // إذا كان ملف واحد، أرسله مباشرة
    if (selectedFiles.length === 1) {
        const file = selectedFiles[0];
        res.attachment(file.name);
        file.createReadStream().pipe(res);
    } 
    // إذا كانت عدة ملفات، قم بضغطها كملف Zip في الوقت الفعلي
    else {
        res.attachment(`${torrent.name || 'download'}.zip`);
        // استخدم مستوى ضغط 0 (store only) لتقليل العبء على الـ CPU الضعيف في Render
        const archive = archiver('zip', { zlib: { level: 0 } });
        archive.pipe(res);

        selectedFiles.forEach(file => {
            archive.append(file.createReadStream(), { name: file.path || file.name });
        });

        archive.finalize();
    }
});

// تنظيف دوري للتورنتات المتروكة (التي جلبوا معلوماتها ولم يحملوها)
setInterval(() => {
    client.torrents.forEach(t => {
        if (!activeDownloads[t.infoHash]) {
            client.remove(t.infoHash, { destroyStore: true });
            console.log(`تنظيف دوري: تم حذف ${t.infoHash}`);
        }
    });
}, 10 * 60 * 1000); // فحص كل 10 دقائق

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر يعمل على منفذ ${PORT}`));
