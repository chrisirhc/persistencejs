var persistence = window.persistence || {};

(function (persistence) {
    var conn = null;
    var entityMeta = {};
    var trackedObjects = {};
    
    persistence.trackedObjects = trackedObjects;

    /**
     * Retrieves metadata about entity, mostly for internal use
     */
    persistence.getMeta = function (entityName) {
        return entityMeta[entityName];
    };

    /**
     * Connect to a database
     * @param dbname the name of the database
     * @param description a human-readable description of the database
     * @param size the maximum size of the database in bytes
     */
    persistence.connect = function (dbname, description, size) {
        persistence._conn = persistence.db.connect(dbname, description, size);
    };

    /**
     * Create a transaction
     * @param callback, the callback function to be invoked when the transaction starts, taking the transaction object as argument
     */
    persistence.transaction = function (callback) {
        persistence._conn.transaction(callback);
    };

    /**
     * Define an entity
     * @param entityName the name of the entity (also the table name in the database)
     * @param fields an object with property names as keys and SQLite types as values, e.g. {name: "TEXT", age: "INT"}
     * @return an entity constructor function
     */
    persistence.define = function (entityName, fields) {
        if (entityMeta[entityName]) { // Already defined, ignore
            return getEntity(entityName);
        }
        var meta = {
            name: entityName,
            fields: fields,
            hasMany: {},
            hasOne: {}
        };
        entityMeta[entityName] = meta;
        return getEntity(entityName);
    };

    /**
     * Synchronize the data model with the database, creates table that had not been defined before
     * @param callback function to be called when synchronization has completed, takes started transaction as argument
     */
    persistence.schemaSync = function (callback) {
        var entityArray = [];
        for ( var entityName in entityMeta) {
            if (entityMeta.hasOwnProperty(entityName)) {
                entityArray.push(entityMeta[entityName]);
            }
        }
        function createOneEntityTable () {
            var meta = entityArray.pop();
            var rowDef = '';
            for ( var prop in meta.fields) {
                if (meta.fields.hasOwnProperty(prop)) {
                    rowDef += prop + " " + meta.fields[prop] + ", ";
                }
            }
            for ( var rel in meta.hasOne) {
                if (meta.hasOne.hasOwnProperty(rel)) {
                    rowDef += rel + " VARCHAR(255), ";
                }
            }
            /*
             * tx.executeSql("CREATE INDEX IF NOT EXISTS `" + meta.name + "_" +
             * collName + "_" + otherMeta.name + "` ON `" + otherMeta.name + "`
             * (`" + fkName + "`)"); });
             */
            rowDef = rowDef.substring(0, rowDef.length - 2);
            persistence._conn.transaction(function (tx) {
                tx.executeSql("CREATE TABLE IF NOT EXISTS `" + meta.name
                        + "` ( id VARCHAR(32) PRIMARY KEY, " + rowDef + ")",
                        null, function () {
                            if (entityArray.length > 0) {
                                createOneEntityTable();
                            } else {
                                if (callback) {
                                    callback(tx);
                                }
                            }
                        });
            });
        }
        createOneEntityTable();
    };

    /**
     * Adds the object to tracked entities to be persisted
     * @param obj the object to be tracked
     */
    persistence.add = function (obj) {
        if (!trackedObjects[obj._id]) {
            trackedObjects[obj._id] = obj;
        }
    };

    /**
     * Persists all changes to the database
     * @param tx transaction to use
     * @param callback function to be called when done
     */
    persistence.flush = function (tx, callback) {
        var objArray = [];
        for ( var id in trackedObjects) {
            if (trackedObjects.hasOwnProperty(id)) {
                objArray.push(trackedObjects[id]);
            }
        }
        function persistOneEntity () {
            var obj = objArray.pop();
            save(obj, tx, function () {
                if (objArray.length > 0) {
                    persistOneEntity();
                } else if (callback) {
                    callback();
                }
            });
        }
        if(objArray.length > 0) {
            persistOneEntity();
        } else {
            callback();
        }
    }
    
    /**
     * Clean the persistence context of cached entities and such.
     */
    persistence.clean = function() {
        persistence.trackedObjects = {};
    }

    /**
     * Remove all tables in the database (as defined by the model)
     */
    persistence.reset = function (tx) {
        var tableArray = [];
        for (p in entityMeta) {
            if (entityMeta.hasOwnProperty(p)) {
                tableArray.push(p);
            }
        }
        function dropOneTable () {
            var tableName = tableArray.pop();
            tx.executeSql("DROP TABLE " + tableName, null, function () {
                if (tableArray.length > 0) {
                    dropOneTable();
                }
            });
        }
        dropOneTable();
    }

    /**
     * Converts a database row into an entity object
     * @internal
     */
    persistence.rowToEntity = function (entityName, row, prefix) {
        prefix = prefix || '';
        if (trackedObjects[row[prefix + "id"]]) { // Cached version
            return trackedObjects[row[prefix + "id"]];
        }
        var rowMeta = entityMeta[entityName];
        var ent = getEntity(entityName);
        var o = new ent();
        o._id = row[prefix+'id'];
        o._new = false;
        for ( var p in row) {
            if (row.hasOwnProperty(p)) {
                if (p.substring(0, prefix.length) === prefix) {
                    var prop = p.substring(prefix.length);
                    if (prop != 'id') {
                        o[prop] = persistence.dbValToEntityVal(row[p],
                                rowMeta.fields[prop]);
                    }
                }
            }
        }
        return o;
    }

    /**
     * Converts a value from the database to a value suitable for the entity (also does type conversions, if necessary)
     * @internal
     */
    persistence.dbValToEntityVal = function (val, type) {
        switch (type) {
        case 'BOOL':
            return val === 1;
            break;
        default:
            return val;
        }
    }

    /**
     * Converts an entity value to a database value (inverse of dbValToEntityVal)
     * @internal
     */
    persistence.entityValToDbVal = function (val, type) {
        if (val === undefined) {
            return null;
        } else if (val._id) {
            return val._id;
        } else if (type === 'BOOL') {
            return val ? 1 : 0;
        } else {
            return val;
        }
    }

    persistence._entityClassCache = {};

    function getEntity (entityName) {
        if (persistence._entityClassCache[entityName]) {
            return persistence._entityClassCache[entityName];
        }
        var meta = entityMeta[entityName];

        var entity = function (obj) {
            var that = {};
            that._id = createUUID();
            that._new = true;
            that._type = entityName;
            that._dirtyProperties = {};
            var data = {};
            var data_obj = {}; // references to objects

            for ( var field in meta.fields) {
                (function () {
                    if (meta.fields.hasOwnProperty(field)) {
                        var f = field; // Javascript scopes/closures SUCK
                        that.__defineSetter__(f, function (val) {
                            data[f] = val;
                            that._dirtyProperties[f] = true;
                        });
                        that.__defineGetter__(f, function () {
                            return data[f];
                        });
                    }
                }());
            }

            for ( var it in meta.hasOne) {
                if (meta.hasOne.hasOwnProperty(it)) {
                    (function () {
                        var ref = it;
                        that.__defineSetter__(ref, function (val) {
                            if (val == null) {
                                data[ref] = null;
                            } else if (val._id) {
                                data[ref] = val._id;
                                data_obj[ref] = val;
                            } else {
                                data[ref] = val;
                            }
                            that._dirtyProperties[ref] = true;
                        });
                        that
                                .__defineGetter__(
                                        ref,
                                        function () {
                                            if (data_obj[ref]) {
                                                return data_obj[ref];
                                            } else {
                                                throw "Property '" + ref + "' with id: "
                                                        + data[ref]
                                                        + " not fetched, either prefetch it or fetch it manually.";
                                            }
                                        });
                    }());
                }
            }

            for ( var f in obj) {
                if (obj.hasOwnProperty(f)) {
                    that[f] = obj[f];
                }
            }

            that.remove = function (tx, callback) {
                remove(that, tx, callback);
            };

            return that;
        }

        entity.meta = meta;

        entity.all = function () {
            return persistence.dbQueryCollection(entityName);
        }

        entity.hasMany = function (collName, otherEntity, invCollName) {
            var otherMeta = otherEntity.meta;
            meta.hasMany[collName] = otherEntity;
            otherMeta.hasOne[invCollName] = entity;
        }

        persistence._entityClassCache[entityName] = entity;
        return entity;
    }

    function save (obj, tx, callback) {
        var rowMeta = entityMeta[obj._type];
        var properties = [];
        var values = [];
        var qs = [];
        var propertyPairs = [];
        for ( var p in obj._dirtyProperties) {
            if (obj._dirtyProperties.hasOwnProperty(p)) {
                properties.push("`" + p + "`");
                values.push(persistence.entityValToDbVal(obj[p]));
                qs.push('?');
                propertyPairs.push("`" + p + "` = ?");
            }
        }
        if (properties.length === 0) { // Nothing changed
            callback();
            return;
        }
        obj._dirtyProperties = {};
        if (obj._new) {
            properties.push('id');
            values.push(obj._id);
            qs.push('?');
            var sql = "INSERT INTO `" + obj._type + "` ("
                    + properties.join(", ") + ") VALUES (" + qs.join(', ')
                    + ")";
            obj._new = false;
            tx.executeSql(sql, values, callback);
        } else {
            var sql = "UPDATE `" + obj._type + "` SET "
                    + propertyPairs.join(',') + " WHERE id = '" + obj._id + "'";
            tx.executeSql(sql, values, callback);
        }
    }

    function remove (obj, tx, callback) {
        var sql = "DELETE FROM `" + obj._type + "` WHERE id = '" + obj._id
                + "'";
        tx.executeSql(sql, null, callback);
    }
}(persistence));